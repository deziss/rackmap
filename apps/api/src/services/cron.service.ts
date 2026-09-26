import { createHash } from "node:crypto";
import {
  CronTarget as CronTargetSchema,
  CRON_USERNAME_PATTERN,
  CROND_FILE_PATTERN,
  CROND_DELETABLE_PATTERN,
  cronEnvAt,
  diffCronLines,
  parseCrontab,
  splitCronCommand,
  validateCrontab,
  type CronKind,
  type CronRunInput,
  type CronRunResponse,
  type CronTarget,
  type CronWriteInput,
} from "@inv/shared";
import type { AuditCtx } from "../lib/audit.js";
import { writeAudit } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { connectToServer, SshError, sshErrorToHttp } from "./ssh.service.js";
import { execAsRoot, RemoteExecError, type RemoteScriptResult } from "./remote-exec.service.js";
import { escapeShellArg } from "./shell-escape.js";
import { PRIVILEGED_OS_GROUPS } from "./os-user.service.js";

/**
 * CONTRACT (Wave 0) — the heartbeats agent's "monitor this job" routes read and
 * write crontabs ONLY through these functions.
 *
 * Every host interaction is one root script run through execAsRoot (uploaded
 * over stdin, never in argv). Script output is a sequence of `===KIND[:name]===`
 * header lines, each optionally followed by ONE base64 payload line, so file
 * content can never be mistaken for a marker.
 */

export interface CronTargetSnapshot {
  target: CronTarget;
  /** Raw file content ("" when the target does not exist yet). */
  content: string;
  /** sha256 hex of `content` — the compare-and-set token for writeCronTarget. */
  hash: string;
  /** User crontab whose owner is root-equivalent (sudo/wheel/docker/... or sudoers rule). */
  privileged: boolean;
  /** Why the owner counts as privileged: "uid0", "group:<name>", "sudoers", "unknown". */
  privilegeReason?: string;
  /** False when the target does not exist on the host yet. */
  exists?: boolean;
  /** Listed for reference only; writes are refused (see `warning`). */
  readOnly?: boolean;
  warning?: string;
  /** Where the target lives on the host, for display. */
  path?: string;
}

export interface CronTimerInfo {
  unit: string;
  activates: string;
  next: string | null;
  last: string | null;
}

export interface CronHostSnapshot {
  /** IANA zone of the host, e.g. "Europe/Berlin"; "UTC" when undeterminable. */
  timezone: string;
  targets: CronTargetSnapshot[];
  timers: CronTimerInfo[];
  warnings?: string[];
}

export interface CronConnOptions {
  overridePassword?: string;
  /**
   * The caller holds server:sudo. Required to write or run system/cron.d/root
   * targets and crontabs of privileged users; without it those are refused
   * with 403 (checked again against the fresh host read, never the client).
   */
  canSudo?: boolean;
}

/** Content above this is listed read-only (CronWriteInput caps content at 64 KiB). */
const MAX_EDITABLE_BYTES = 65_536;
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 60_000;
const RUN_OUTPUT_CAP = 64 * 1024;
const READ_OUTPUT_CAP = 8 * 1024 * 1024;
const BACKUP_DIR = "/var/backups/rackmap-cron";
const BACKUP_KEEP = 10;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function cronKindOf(target: CronTarget): CronKind {
  return target.kind === "user" ? "user" : "system";
}

export function cronTargetLabel(target: CronTarget): string {
  if (target.kind === "user") return `crontab of ${target.user}`;
  if (target.kind === "system") return "/etc/crontab";
  return `/etc/cron.d/${target.file}`;
}

function sameTarget(a: CronTarget, b: CronTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "user" && b.kind === "user") return a.user === b.user;
  if (a.kind === "crond" && b.kind === "crond") return a.file === b.file;
  return true;
}

/** Needs server:sudo regardless of what the host reports: system crontabs, cron.d and root. */
export function cronTargetNeedsSudo(target: CronTarget): boolean {
  return target.kind !== "user" || target.user === "root";
}

/** Mask obvious credentials before a command line reaches the audit log. */
export function maskCronSecrets(text: string): string {
  return text.replace(/(password|passwd|pwd|token|secret|api[_-]?key)=\S+/gi, "$1=***");
}

/** Per-line change summary for the audit row (masked, bounded). */
export function summarizeCronDiff(before: string, after: string) {
  const changed = diffCronLines(before, after).filter((o) => o.op !== "same");
  const MAX = 40;
  return {
    added: changed.filter((o) => o.op === "add").length,
    removed: changed.filter((o) => o.op === "del").length,
    lines: changed.slice(0, MAX).map((o) => `${o.op === "add" ? "+" : "-"} ${maskCronSecrets(o.text).slice(0, 300)}`),
    truncated: changed.length > MAX,
  };
}

/** Re-check a target at the point of interpolation; the route validated it too. */
function checkedTarget(target: CronTarget): CronTarget {
  const parsed = CronTargetSchema.safeParse(target);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid cron target", 400);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const PRELUDE = `set +e
umask 077
exec </dev/null
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
command -v base64 >/dev/null 2>&1 || { echo '===FATAL:NO_BASE64==='; exit 3; }
W=$(mktemp -d 2>/dev/null) || { echo '===FATAL:MKTEMP==='; exit 3; }
trap 'rm -rf "$W"' EXIT
trap 'exit 130' INT TERM HUP
b64() { base64 | tr -d '\\n'; echo; }
emit() { printf '===%s===\\n' "$1"; }
`;

/**
 * Root-equivalent groups for priv_block, shared with the OS-user editor so the
 * two can never disagree (adm/shadow read logs and password hashes; a cron job
 * or "run now" as such a user reads them too).
 */
const PRIVILEGED_GROUP_CASE = PRIVILEGED_OS_GROUPS.join("|");

const READ_FUNCTIONS = `safe_name() {
  case "$1" in ''|-*|*[!A-Za-z0-9_.-]*) return 1 ;; esac
  return 0
}
tz_block() {
  tz=
  if command -v timedatectl >/dev/null 2>&1; then tz=$(timedatectl show -p Timezone --value 2>/dev/null); fi
  if [ -z "$tz" ] && [ -r /etc/timezone ]; then tz=$(head -n 1 /etc/timezone 2>/dev/null); fi
  if [ -z "$tz" ] && [ -L /etc/localtime ]; then tz=$(readlink /etc/localtime 2>/dev/null); tz=\${tz#*zoneinfo/}; fi
  emit TZ; printf '%s' "$tz" | b64
}
priv_block() {
  pu=$1; r=
  uid=$(id -u "$pu" 2>/dev/null)
  if [ -z "$uid" ]; then r=unknown
  elif [ "$uid" = 0 ]; then r=uid0
  else
    for g in $(id -Gn "$pu" 2>/dev/null); do
      case "$g" in ${PRIVILEGED_GROUP_CASE}) r="group:$g"; break ;; esac
    done
    if [ -z "$r" ] && command -v sudo >/dev/null 2>&1; then
      if sudo -n -l -U "$pu" 2>/dev/null | grep -q 'may run the following'; then r=sudoers; fi
    fi
  fi
  emit "PRIV:$pu"; printf '%s' "$r" | b64
}
user_block() {
  u=$1
  id -u "$u" >/dev/null 2>&1 || emit "NOUSER:$u"
  if crontab -l -u "$u" >"$W/c" 2>"$W/e"; then
    emit "USER:$u"; b64 <"$W/c"
  else
    for s in /var/spool/cron/crontabs/"$u" /var/spool/cron/"$u"; do
      if [ -f "$s" ]; then
        emit "RAWUSER:$u"; head -c 131073 "$s" | b64
        emit "ERR:$u"; head -c 400 "$W/e" | b64
        break
      fi
    done
  fi
  priv_block "$u"
}
system_block() {
  if [ -f /etc/crontab ]; then emit SYSTEM; head -c 131073 /etc/crontab | b64; fi
}
crond_block() {
  if [ -f "/etc/cron.d/$1" ]; then emit "CROND:$1"; head -c 131073 "/etc/cron.d/$1" | b64; fi
}
`;

/** The whole host: every spool crontab, /etc/crontab, /etc/cron.d/*, systemd timers. */
export function buildCronReadAllScript(): string {
  return `${PRELUDE}${READ_FUNCTIONS}
tz_block
seen=' '
for d in /var/spool/cron/crontabs /var/spool/cron; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    [ -f "$f" ] || continue
    n=\${f##*/}
    case "$seen" in *" $n "*) continue ;; esac
    seen="$seen$n "
    if safe_name "$n"; then user_block "$n"; else emit WARN; printf 'Skipped a crontab in %s with an unusual file name' "$d" | b64; fi
  done
done
command -v crontab >/dev/null 2>&1 || emit NOCRON
system_block
if [ -d /etc/cron.d ]; then
  for f in /etc/cron.d/*; do
    [ -f "$f" ] || continue
    n=\${f##*/}
    if safe_name "$n"; then crond_block "$n"; else emit WARN; printf 'Skipped an /etc/cron.d file with an unusual name' | b64; fi
  done
fi
if command -v systemctl >/dev/null 2>&1; then
  emit TIMERS; systemctl list-timers --all --no-pager --plain 2>/dev/null | head -c 65536 | b64
fi
emit END
`;
}

/** One target (plus the host timezone and, for users, the privilege check). */
export function buildCronReadTargetScript(target: CronTarget): string {
  const t = checkedTarget(target);
  let body: string;
  if (t.kind === "user") body = `user_block ${escapeShellArg(t.user)}`;
  else if (t.kind === "system") body = "system_block";
  else body = `crond_block ${escapeShellArg(t.file)}`;
  return `${PRELUDE}${READ_FUNCTIONS}
tz_block
${body}
emit END
`;
}

function backupPrefix(t: CronTarget): string {
  if (t.kind === "user") return `user-${t.user}`;
  if (t.kind === "system") return "system-crontab";
  return `crond-${t.file}`;
}

/**
 * Replace (or, for rackmap-* cron.d files, delete) one target. The script checks
 * the host's current sha256 against `baseHash` itself (exit 3 → CONFLICT), backs
 * the old content up, and writes through a temp file: `crontab -u` for user
 * crontabs (which syntax-checks), `install` + rename for system files. The new
 * content travels only as base64 and is decoded on the host.
 */
export function buildCronWriteScript(
  target: CronTarget,
  content: string,
  baseHash: string,
  opts: { deleteFile?: boolean } = {},
): string {
  const t = checkedTarget(target);
  if (!/^[a-f0-9]{64}$/.test(baseHash)) throw new AppError("VALIDATION_ERROR", "Invalid baseHash", 400);
  const b64 = Buffer.from(content, "utf8").toString("base64");

  let setup: string;
  let current: string;
  let write: string;
  if (t.kind === "user") {
    setup = `U=${escapeShellArg(t.user)}`;
    current = `crontab -l -u "$U" >"$W/cur" 2>/dev/null || : >"$W/cur"`;
    write = `printf '%s' '${b64}' | base64 -d >"$W/new" || { emit FATAL:DECODE; exit 4; }
if ! crontab -u "$U" "$W/new" >"$W/err" 2>&1; then emit FAILED; b64 <"$W/err"; exit 5; fi
emit AFTER; crontab -l -u "$U" 2>/dev/null | b64`;
  } else {
    const file = t.kind === "system" ? "/etc/crontab" : `/etc/cron.d/${t.file}`;
    setup = `F=${escapeShellArg(file)}
D=\${F%/*}`;
    current = `if [ -f "$F" ]; then cat "$F" >"$W/cur"; else : >"$W/cur"; fi`;
    if (opts.deleteFile) {
      write = `if [ -e "$F" ]; then rm -f -- "$F" 2>"$W/err" || { emit FAILED; b64 <"$W/err"; exit 5; }; fi
emit AFTER; printf '' | b64`;
    } else {
      write = `[ -d "$D" ] || { emit FAILED; printf 'Directory %s does not exist on this host' "$D" | b64; exit 5; }
printf '%s' '${b64}' | base64 -d >"$W/new" || { emit FATAL:DECODE; exit 4; }
T="$D/.rackmap-new.$$"
if install -o root -g root -m 0644 "$W/new" "$T" 2>"$W/err" && mv -f "$T" "$F" 2>>"$W/err"; then :; else rm -f "$T"; emit FAILED; b64 <"$W/err"; exit 5; fi
if command -v restorecon >/dev/null 2>&1; then restorecon "$F" >/dev/null 2>&1; fi
emit AFTER; b64 <"$F"`;
    }
  }

  return `${PRELUDE}
${setup}
B=${BACKUP_DIR}
P=${escapeShellArg(backupPrefix(t))}
${current}
if command -v sha256sum >/dev/null 2>&1; then
  h=$(sha256sum <"$W/cur" | cut -d' ' -f1)
  [ "$h" = '${baseHash}' ] || { emit CONFLICT; exit 3; }
fi
if [ -s "$W/cur" ]; then
  mkdir -p "$B" && chmod 0700 "$B" || { emit FATAL:BACKUP; exit 4; }
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dst="$B/$P.$ts"
  [ -e "$dst" ] && dst="$dst-$$"
  cp "$W/cur" "$dst" && chmod 0600 "$dst" || { emit FATAL:BACKUP; exit 4; }
  ls -1d "$B/$P".2* 2>/dev/null | sort -r | tail -n +${BACKUP_KEEP + 1} | while IFS= read -r old; do rm -f -- "$old"; done
  emit BACKUP; printf '%s' "$dst" | b64
fi
${write}
emit END
`;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_PATH_PATTERN = /^\/[A-Za-z0-9._/+-]+$/;

/**
 * Run one entry's command the way cron would: as its user (runuser), from their
 * home directory, with a cron-like environment plus the crontab's own env lines,
 * the crontab's SHELL, and the `%` stdin part fed on stdin.
 */
export function buildCronRunScript(user: string, command: string, env: Record<string, string>): string {
  if (user.length > 32 || !CRON_USERNAME_PATTERN.test(user)) throw new AppError("VALIDATION_ERROR", "Invalid user", 400);
  const { command: cmd, stdin } = splitCronCommand(command);
  const shell = env["SHELL"] && SHELL_PATH_PATTERN.test(env["SHELL"]) && !env["SHELL"].split("/").includes("..")
    ? env["SHELL"]
    : "/bin/sh";
  const envArgs = Object.entries(env)
    .filter(([k]) => ENV_NAME_PATTERN.test(k))
    .map(([k, v]) => escapeShellArg(`${k}=${v}`))
    .join(" ");
  const run = stdin === null
    ? `"$@" </dev/null`
    : `printf '%s' '${Buffer.from(stdin, "utf8").toString("base64")}' | base64 -d | "$@"`;
  return `set +e
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
U=${escapeShellArg(user)}
id -u "$U" >/dev/null 2>&1 || { echo "rackmap: user $U does not exist on this host" >&2; exit 127; }
H=$(getent passwd "$U" 2>/dev/null | cut -d: -f6)
[ -n "$H" ] || H=$(awk -F: -v u="$U" '$1 == u { print $6; exit }' /etc/passwd 2>/dev/null)
[ -n "$H" ] || H=/
cd "$H" 2>/dev/null || cd /
set -- env -i "HOME=$H" "LOGNAME=$U" "USER=$U" PATH=/usr/bin:/bin SHELL=/bin/sh ${envArgs} ${escapeShellArg(shell)} -c ${escapeShellArg(cmd)}
if [ "$U" != root ]; then
  command -v runuser >/dev/null 2>&1 || { echo 'rackmap: runuser not found on this host' >&2; exit 127; }
  set -- runuser -u "$U" -- "$@"
fi
${run}
`;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

interface Block {
  kind: string;
  name: string;
  payload: string;
}

const HEADER_PATTERN = /^===([A-Z]+)(?::([^=\n]*))?===$/;
const B64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function parseBlocks(stdout: string): Block[] {
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, ""));
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER_PATTERN.exec(lines[i]!);
    if (!m) continue;
    let payload = "";
    const next = lines[i + 1];
    if (next !== undefined && !HEADER_PATTERN.test(next)) {
      payload = next.trim();
      i++;
    }
    blocks.push({ kind: m[1]!, name: m[2] ?? "", payload });
  }
  return blocks;
}

function decodePayload(payload: string): Buffer | null {
  if (!B64_PATTERN.test(payload)) return null;
  return Buffer.from(payload, "base64");
}

function decodeText(payload: string): string {
  return decodePayload(payload)?.toString("utf8") ?? "";
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function contentSnapshot(target: CronTarget, payload: string, path?: string): CronTargetSnapshot {
  const buf = decodePayload(payload);
  const snap: CronTargetSnapshot = { target, content: "", hash: sha256Hex(""), privileged: false, exists: true };
  if (path) snap.path = path;
  if (!buf) {
    snap.readOnly = true;
    snap.warning = "The host returned unreadable data for this file";
    return snap;
  }
  snap.hash = sha256Hex(buf);
  try {
    snap.content = utf8.decode(buf);
  } catch {
    snap.content = buf.toString("utf8");
    snap.readOnly = true;
    snap.warning = "Not valid UTF-8 — edit this file on the host";
  }
  if (buf.length > MAX_EDITABLE_BYTES) {
    snap.readOnly = true;
    snap.warning = `Larger than ${MAX_EDITABLE_BYTES / 1024} KiB — edit this file on the host`;
  }
  return snap;
}

function validTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Fri 2026-09-25 22:20:00 UTC" as printed by systemctl (zone optional). */
const TIMER_TIMESTAMP = /[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [A-Z][A-Za-z0-9+_-]*)?/g;

/**
 * `systemctl list-timers --plain` → rows. LEFT/PASSED are right-aligned in
 * current systemd, so columns are not sliced at header offsets: the unit and
 * its target are the last two words, NEXT is a timestamp at the start of the
 * row and LAST the timestamp after it ("-"/"n/a" when never/not scheduled).
 */
export function parseTimers(text: string): CronTimerInfo[] {
  const out: CronTimerInfo[] = [];
  for (const row of text.split("\n")) {
    const m = /(\S+\.timer)\s+(\S+)\s*$/.exec(row);
    if (!m) continue;
    const stamps = [...row.slice(0, m.index).matchAll(TIMER_TIMESTAMP)];
    out.push({
      unit: m[1]!,
      activates: m[2]!,
      next: stamps.find((s) => s.index === 0)?.[0] ?? null,
      last: stamps.find((s) => (s.index ?? 0) > 0)?.[0] ?? null,
    });
  }
  return out;
}

interface ParsedRead {
  timezone: string;
  targets: CronTargetSnapshot[];
  timers: CronTimerInfo[];
  warnings: string[];
  /** Users the host reported as nonexistent. */
  missingUsers: Set<string>;
}

class CronHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronHostError";
  }
}

function fatalMessage(code: string): string {
  switch (code) {
    case "NO_BASE64":
      return "The host has no base64 command (coreutils/busybox), which the cron editor needs";
    case "MKTEMP":
      return "Could not create a temporary directory on the host";
    case "BACKUP":
      return `Could not back up the current crontab to ${BACKUP_DIR}; nothing was changed`;
    case "DECODE":
      return "Could not decode the new crontab on the host; nothing was changed";
    default:
      return `Cron script failed on the host (${code})`;
  }
}

/** Turn read-script output into a snapshot. Exported for tests. */
export function parseCronReadOutput(stdout: string): ParsedRead {
  const blocks = parseBlocks(stdout);
  const fatal = blocks.find((b) => b.kind === "FATAL");
  if (fatal) throw new CronHostError(fatalMessage(fatal.name));
  if (!blocks.some((b) => b.kind === "END")) throw new CronHostError("Incomplete output from the host while reading crontabs");

  const warnings: string[] = [];
  const users = new Map<string, CronTargetSnapshot>();
  const priv = new Map<string, string>();
  const errors = new Map<string, string>();
  const missingUsers = new Set<string>();
  const crond: CronTargetSnapshot[] = [];
  let system: CronTargetSnapshot | null = null;
  let timezone = "UTC";
  let timers: CronTimerInfo[] = [];

  for (const b of blocks) {
    switch (b.kind) {
      case "TZ": {
        const tz = decodeText(b.payload).trim();
        if (validTimezone(tz)) timezone = tz;
        else if (tz) warnings.push(`Unrecognised host timezone "${tz.slice(0, 64)}"; showing times in UTC`);
        break;
      }
      case "USER":
      case "RAWUSER": {
        if (b.name.length > 32 || !CRON_USERNAME_PATTERN.test(b.name)) {
          warnings.push("Skipped a crontab whose owner name is not a valid Linux username");
          break;
        }
        const snap = contentSnapshot({ kind: "user", user: b.name }, b.payload);
        if (b.kind === "RAWUSER") {
          snap.readOnly = true;
          snap.warning = "crontab refused to list this user";
        }
        users.set(b.name, snap);
        break;
      }
      case "ERR":
        errors.set(b.name, decodeText(b.payload).trim().slice(0, 400));
        break;
      case "NOUSER":
        missingUsers.add(b.name);
        break;
      case "PRIV":
        priv.set(b.name, decodeText(b.payload).trim());
        break;
      case "SYSTEM":
        system = contentSnapshot({ kind: "system" }, b.payload, "/etc/crontab");
        break;
      case "CROND": {
        const snap = contentSnapshot({ kind: "crond", file: b.name }, b.payload, `/etc/cron.d/${b.name}`);
        if (!CROND_FILE_PATTERN.test(b.name)) {
          snap.readOnly = true;
          snap.warning =
            "Debian's cron ignores /etc/cron.d files whose names contain anything but letters, digits, '_' and '-' (cronie may still load it); listed read-only";
        }
        crond.push(snap);
        break;
      }
      case "TIMERS":
        timers = parseTimers(decodeText(b.payload));
        break;
      case "WARN":
        warnings.push(decodeText(b.payload).trim().slice(0, 300));
        break;
      case "NOCRON":
        warnings.push("The crontab command was not found on the host — is cron installed?");
        break;
    }
  }

  for (const [name, snap] of users) {
    const reason = priv.get(name) ?? "unknown";
    snap.privileged = reason !== "";
    if (reason) snap.privilegeReason = reason;
    if (missingUsers.has(name)) {
      snap.readOnly = true;
      snap.warning = "The owner of this crontab no longer exists on the host";
    } else if (snap.warning === "crontab refused to list this user" && errors.get(name)) {
      snap.warning = `crontab refused to list this user: ${errors.get(name)}`;
    }
  }

  const userTargets = [...users.values()].sort((a, b) => {
    const ua = a.target.kind === "user" ? a.target.user : "";
    const ub = b.target.kind === "user" ? b.target.user : "";
    if (ua === "root") return -1;
    if (ub === "root") return 1;
    return ua.localeCompare(ub);
  });
  crond.sort((a, b) => (a.target.kind === "crond" && b.target.kind === "crond" ? a.target.file.localeCompare(b.target.file) : 0));
  const targets = [...userTargets, ...(system ? [system] : []), ...crond];
  // Remember the privilege verdict of users that have no crontab yet (single-target reads).
  for (const [name, reason] of priv) {
    if (!users.has(name)) {
      const snap: CronTargetSnapshot = {
        target: { kind: "user", user: name },
        content: "",
        hash: sha256Hex(""),
        privileged: reason !== "",
        exists: false,
      };
      if (reason) snap.privilegeReason = reason;
      if (missingUsers.has(name)) {
        snap.readOnly = true;
        snap.warning = "No such user on the host";
      }
      targets.push(snap);
    }
  }
  return { timezone, targets, timers, warnings, missingUsers };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Conn = Awaited<ReturnType<typeof connectToServer>>;

async function withHost<T>(serverId: number, opts: CronConnOptions, fn: (conn: Conn) => Promise<T>): Promise<T> {
  const conn = opts.overridePassword ? await connectToServer(serverId, opts.overridePassword) : await connectToServer(serverId);
  try {
    return await fn(conn);
  } finally {
    conn.client.end();
  }
}

function translateExecError(err: unknown, conn: Conn): unknown {
  if (
    err instanceof RemoteExecError &&
    (err.code === "SUDO_PASSWORD_REQUIRED" || err.code === "SUDO_AUTH_FAILED") &&
    conn.passwordUnavailable === "vault_locked"
  ) {
    return new AppError("VAULT_LOCKED", "sudo on this host needs the server's SSH password — unlock the credential vault", 409);
  }
  return err;
}

async function runRoot(
  conn: Conn,
  script: string,
  opts: { timeoutMs: number; maxOutputBytes: number; allowTimeout?: boolean },
): Promise<RemoteScriptResult> {
  let res: RemoteScriptResult;
  try {
    res = await execAsRoot(conn.client, script, conn.password, { timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes });
  } catch (err) {
    throw translateExecError(err, conn);
  }
  if (res.errorCode && !(opts.allowTimeout && res.errorCode === "TIMEOUT")) {
    const msg = res.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300) || res.errorCode;
    throw translateExecError(new RemoteExecError(res.errorCode, msg), conn);
  }
  return res;
}

async function readTargetOn(conn: Conn, target: CronTarget): Promise<CronTargetSnapshot & { timezone: string }> {
  const res = await runRoot(conn, buildCronReadTargetScript(target), { timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: READ_OUTPUT_CAP });
  const parsed = parseCronReadOutput(res.stdout);
  const found = parsed.targets.find((s) => sameTarget(s.target, target));
  if (found) return { ...found, timezone: parsed.timezone };
  const snap: CronTargetSnapshot & { timezone: string } = {
    target,
    content: "",
    hash: sha256Hex(""),
    privileged: false,
    exists: false,
    timezone: parsed.timezone,
  };
  if (target.kind === "system") snap.path = "/etc/crontab";
  if (target.kind === "crond") snap.path = `/etc/cron.d/${target.file}`;
  return snap;
}

export async function readCronTargets(serverId: number, opts: CronConnOptions = {}): Promise<CronHostSnapshot> {
  return withHost(serverId, opts, async (conn) => {
    const res = await runRoot(conn, buildCronReadAllScript(), { timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: READ_OUTPUT_CAP });
    if (res.stdoutTruncated) throw new CronHostError("The host's cron configuration is too large to load");
    const parsed = parseCronReadOutput(res.stdout);
    // Always offer /etc/crontab, even when the host has none yet.
    if (!parsed.targets.some((t) => t.target.kind === "system")) {
      const firstCrond = parsed.targets.findIndex((t) => t.target.kind === "crond");
      const sys: CronTargetSnapshot = {
        target: { kind: "system" },
        content: "",
        hash: sha256Hex(""),
        privileged: false,
        exists: false,
        path: "/etc/crontab",
      };
      if (firstCrond < 0) parsed.targets.push(sys);
      else parsed.targets.splice(firstCrond, 0, sys);
    }
    const snapshot: CronHostSnapshot = { timezone: parsed.timezone, targets: parsed.targets, timers: parsed.timers };
    if (parsed.warnings.length) snapshot.warnings = parsed.warnings;
    return snapshot;
  });
}

export async function readCronTarget(
  serverId: number,
  target: CronTarget,
  opts: CronConnOptions = {},
): Promise<CronTargetSnapshot & { timezone: string }> {
  const t = checkedTarget(target);
  return withHost(serverId, opts, (conn) => readTargetOn(conn, t));
}

function assertMaySudo(target: CronTarget, snap: CronTargetSnapshot | null, canSudo: boolean | undefined) {
  if (canSudo) return;
  if (cronTargetNeedsSudo(target)) {
    throw new AppError("FORBIDDEN", `Editing ${cronTargetLabel(target)} requires the server:sudo permission`, 403);
  }
  if (snap?.privileged) {
    throw new AppError(
      "FORBIDDEN",
      `${cronTargetLabel(target)} belongs to a root-equivalent user (${snap.privilegeReason ?? "privileged"}); this requires the server:sudo permission`,
      403,
    );
  }
}

function assertWritable(snap: CronTargetSnapshot, target: CronTarget) {
  if (snap.readOnly) {
    throw new AppError("CONFLICT", `${cronTargetLabel(target)} can only be edited on the host: ${snap.warning ?? "read-only"}`, 409);
  }
}

function conflict(target: CronTarget): AppError {
  return new AppError("CRON_CONFLICT", `${cronTargetLabel(target)} changed on the host since it was loaded — reload and reapply your change`, 409);
}

/** Validate new content like cron would (400 with every offending line). */
export function assertValidCronContent(content: string, kind: CronKind): void {
  if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_BYTES) {
    throw new AppError("VALIDATION_ERROR", `Crontab is larger than ${MAX_EDITABLE_BYTES / 1024} KiB`, 400);
  }
  if (content.includes("\0")) throw new AppError("VALIDATION_ERROR", "Crontab contains a NUL byte", 400);
  const problems = validateCrontab(content, kind);
  if (problems.length) {
    const head = problems
      .slice(0, 5)
      .map((p) => `line ${p.lineNo}: ${p.error}`)
      .join("; ");
    throw new AppError("VALIDATION_ERROR", `Invalid crontab — ${head}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`, 400, {
      problems,
    });
  }
}

/**
 * Replace a whole target. Throws AppError("CRON_CONFLICT", …, 409) when the host's
 * current sha256 differs from input.baseHash. Backs the old content up on the host.
 */
export async function writeCronTarget(
  serverId: number,
  input: CronWriteInput & { deleteFile?: boolean },
  ctx: AuditCtx,
  opts: CronConnOptions = {},
): Promise<{ hash: string }> {
  const target = checkedTarget(input.target);
  const kind = cronKindOf(target);
  let content = input.content;
  if (input.deleteFile) {
    if (target.kind !== "crond" || !CROND_DELETABLE_PATTERN.test(target.file)) {
      throw new AppError("VALIDATION_ERROR", "Only /etc/cron.d files named rackmap-* can be deleted from RackMap", 400);
    }
    if (content !== "") throw new AppError("VALIDATION_ERROR", "Deleting a file requires empty content", 400);
  } else {
    if (content !== "" && !content.endsWith("\n")) content += "\n";
    assertValidCronContent(content, kind);
  }
  // Static RBAC first, so a forbidden target never costs an SSH connection.
  assertMaySudo(target, null, opts.canSudo);

  return withHost(serverId, opts, async (conn) => {
    const current = await readTargetOn(conn, target);
    if (target.kind === "user" && !current.exists && current.readOnly) {
      throw new AppError("VALIDATION_ERROR", `User ${target.user} does not exist on the host`, 400);
    }
    assertMaySudo(target, current, opts.canSudo);
    assertWritable(current, target);
    if (current.hash !== input.baseHash) throw conflict(target);

    const res = await runRoot(conn, buildCronWriteScript(target, content, input.baseHash, { deleteFile: input.deleteFile }), {
      timeoutMs: WRITE_TIMEOUT_MS,
      maxOutputBytes: READ_OUTPUT_CAP,
    });
    const blocks = parseBlocks(res.stdout);
    const fatal = blocks.find((b) => b.kind === "FATAL");
    if (fatal) throw new CronHostError(fatalMessage(fatal.name));
    if (blocks.some((b) => b.kind === "CONFLICT")) throw conflict(target);
    const failed = blocks.find((b) => b.kind === "FAILED");
    if (failed) {
      const msg = decodeText(failed.payload).trim().slice(0, 500) || "unknown error";
      if (target.kind === "user") throw new AppError("VALIDATION_ERROR", `crontab rejected the new file: ${msg}`, 400);
      throw new CronHostError(`Could not write ${cronTargetLabel(target)}: ${msg}`);
    }
    const after = blocks.find((b) => b.kind === "AFTER");
    if (!after || !blocks.some((b) => b.kind === "END")) throw new CronHostError("Incomplete output from the host while writing the crontab");
    const afterBuf = decodePayload(after.payload) ?? Buffer.from(content, "utf8");
    const hash = sha256Hex(afterBuf);
    const backup = blocks.find((b) => b.kind === "BACKUP");

    await writeAudit({
      ctx,
      category: "security",
      action: "server.cron_update",
      entity: "server",
      entityId: String(serverId),
      before: { target, hash: current.hash },
      after: {
        target,
        hash,
        deleted: input.deleteFile === true,
        backup: backup ? decodeText(backup.payload) : null,
        changes: summarizeCronDiff(current.content, afterBuf.toString("utf8")),
      },
    });
    return { hash };
  });
}

/** POST /servers/:id/cron/run — run one saved entry now, as its user. */
export async function runCronEntry(
  serverId: number,
  input: CronRunInput,
  ctx: AuditCtx,
  opts: CronConnOptions = {},
): Promise<CronRunResponse> {
  const target = checkedTarget(input.target);
  assertMaySudo(target, null, opts.canSudo);

  return withHost(serverId, opts, async (conn) => {
    const current = await readTargetOn(conn, target);
    assertMaySudo(target, current, opts.canSudo);
    if (current.hash !== input.baseHash) throw conflict(target);
    const lines = parseCrontab(current.content, cronKindOf(target));
    const entry = lines.find((l) => l.lineNo === input.lineNo);
    if (!entry || entry.type !== "entry") {
      throw new AppError("VALIDATION_ERROR", `Line ${input.lineNo} of ${cronTargetLabel(target)} is not a cron job`, 400);
    }
    const user = target.kind === "user" ? target.user : entry.user;
    if (!user) throw new AppError("VALIDATION_ERROR", "The entry names no user", 400);
    // A root job in /etc/crontab needs sudo; so does a job owned by a privileged user.
    if (!opts.canSudo && user === "root") {
      throw new AppError("FORBIDDEN", "Running a job as root requires the server:sudo permission", 403);
    }

    const res = await runRoot(conn, buildCronRunScript(user, entry.command, cronEnvAt(lines, entry.lineNo)), {
      timeoutMs: RUN_TIMEOUT_MS,
      maxOutputBytes: RUN_OUTPUT_CAP,
      allowTimeout: true,
    });
    const result: CronRunResponse = {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      truncated: res.stdoutTruncated || res.stderrTruncated,
      timedOut: res.timedOut || res.errorCode === "TIMEOUT",
      durationMs: res.durationMs,
    };
    await writeAudit({
      ctx,
      category: "security",
      action: "server.cron_run",
      entity: "server",
      entityId: String(serverId),
      after: {
        target,
        lineNo: entry.lineNo,
        user,
        command: maskCronSecrets(entry.command).slice(0, 500),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      },
    });
    return result;
  });
}

/** HTTP mapping for everything the cron service can throw except AppError (rethrow those). */
export function cronErrorToHttp(err: unknown): { status: 400 | 404 | 409 | 502 | 503 | 504; code: string; message: string } {
  if (err instanceof SshError) {
    // Keep the code a client branches on (VAULT_LOCKED -> "unlock the vault").
    const { status, message, code } = sshErrorToHttp(err);
    return { status, code: code ?? "SSH_ERROR", message };
  }
  if (err instanceof RemoteExecError) {
    switch (err.code) {
      case "SUDO_PASSWORD_REQUIRED":
        return { status: 409, code: "SUDO_ERROR", message: "sudo on this host needs a password: store the server's SSH password or unlock the vault" };
      case "SUDO_AUTH_FAILED":
        return { status: 409, code: "SUDO_ERROR", message: "sudo on the host rejected the password saved for this server" };
      case "SUDO_NOT_ALLOWED":
        return { status: 409, code: "SUDO_ERROR", message: "The SSH user may not run commands as root via sudo" };
      case "SUDO_REQUIRETTY":
        return { status: 409, code: "SUDO_ERROR", message: "sudo on this host requires a TTY (Defaults requiretty)" };
      case "TIMEOUT":
        return { status: 504, code: "REMOTE_EXEC_ERROR", message: "The host did not finish in time" };
      default:
        return { status: 502, code: "REMOTE_EXEC_ERROR", message: err.message || "Remote execution failed" };
    }
  }
  if (err instanceof CronHostError) return { status: 502, code: "CRON_HOST_ERROR", message: err.message };
  const message = (err as { message?: string } | null)?.message || "Cron operation failed";
  return { status: 502, code: "CRON_HOST_ERROR", message };
}
