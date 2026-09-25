import { createHash } from "node:crypto";
import {
  DRIFT_CATEGORIES,
  type DriftAuthorizedKey,
  type DriftCategory,
  type DriftGroup,
  type DriftPort,
  type DriftSnapshotData,
  type DriftUser,
} from "@inv/shared";
import { PRIVILEGED_OS_GROUPS } from "./os-user.service.js";
import { sha256Hex, sudoersSubjects } from "./drift-diff.js";

/**
 * The drift snapshot script and the parser for what it prints.
 *
 * One read-only /bin/sh script collects every category. It runs through
 * execPreferRoot: as root when sudo is usable, otherwise as the SSH user, in
 * which case the categories a non-root user can only see part of (sudoers,
 * user crontabs, other users' authorized_keys) are reported UNAVAILABLE rather
 * than collected partially — a partial list would read as "removed" in the diff.
 *
 * Output protocol (as in cron.service): a `===KIND[:name]===` header line,
 * always followed by exactly ONE payload line — base64 for anything that comes
 * from a file, so file content can never be mistaken for a header. Names in
 * headers are checked with safe_name first. A snapshot is only accepted when
 * the closing END header arrived.
 *
 * Crontabs are hashed on the host (sha256sum) so their content — which often
 * carries credentials — never leaves it; only hosts without sha256sum ship the
 * file for hashing here. Authorized keys are shipped as the key lines only (grep
 * for a key type), and fingerprinted here exactly as `ssh-keygen -lf` does
 * (SHA256 of the key blob), so hosts without ssh-keygen and lines with options
 * behave the same; only fingerprints are stored.
 */

const FILE_CAP = 1_048_576;
const DB_CAP = 4 * 1_048_576;
const KEYS_CAP = 262_144;

export const DRIFT_SCRIPT = `set +e
umask 077
exec </dev/null
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
command -v base64 >/dev/null 2>&1 || { printf '===FATAL:NO_BASE64===\\n\\n'; exit 3; }
W=$(mktemp -d 2>/dev/null) || { printf '===FATAL:MKTEMP===\\n\\n'; exit 3; }
trap 'rm -rf "$W"' EXIT
trap 'exit 130' INT TERM HUP
b64() { base64 | tr -d '\\n'; echo; }
emit() { printf '===%s===\\n' "$1"; }
note() { emit "$1"; printf '%s' "$2" | b64; }
safe_name() {
  case "$1" in ''|-*|*[!A-Za-z0-9_.-]*) return 1 ;; esac
  return 0
}
pw() { getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null; }
ROOT=0
[ "$(id -u 2>/dev/null)" = 0 ] && ROOT=1
NEEDROOT='needs root, and sudo was not usable for the SSH user'
emit ROOT; echo "$ROOT"

emit PASSWD; pw | head -c ${DB_CAP} | b64
emit GROUP; { getent group 2>/dev/null || cat /etc/group 2>/dev/null; } | head -c ${DB_CAP} | b64

if [ "$ROOT" = 1 ]; then
  emit SUDOERS
  {
    [ -f /etc/sudoers ] && cat /etc/sudoers && echo
    if [ -d /etc/sudoers.d ]; then
      for f in /etc/sudoers.d/*; do
        [ -f "$f" ] || continue
        cat "$f"; echo
      done
    fi
  } 2>/dev/null | head -c ${FILE_CAP} | b64
else
  note UNAVAILABLE:sudoers "reading /etc/sudoers $NEEDROOT"
fi

if [ "$ROOT" = 1 ]; then
  HAVE_SHA=0
  command -v sha256sum >/dev/null 2>&1 && HAVE_SHA=1
  cron_file() {
    if [ "$HAVE_SHA" = 1 ]; then emit "CRONH:$1"; sha256sum <"$2" 2>/dev/null | cut -d' ' -f1
    else emit "CRONB:$1"; head -c ${FILE_CAP} "$2" | b64; fi
  }
  emit CRONTABS; echo
  seen=' '
  for d in /var/spool/cron/crontabs /var/spool/cron; do
    [ -d "$d" ] || continue
    for f in "$d"/*; do
      [ -f "$f" ] || continue
      n=\${f##*/}
      case "$seen" in *" $n "*) continue ;; esac
      seen="$seen$n "
      if safe_name "$n"; then cron_file "user:$n" "$f"; else note WARN "Skipped a crontab in $d with an unusual file name"; fi
    done
  done
  [ -f /etc/crontab ] && cron_file system /etc/crontab
  if [ -d /etc/cron.d ]; then
    for f in /etc/cron.d/*; do
      [ -f "$f" ] || continue
      n=\${f##*/}
      if safe_name "$n"; then cron_file "crond:$n" "$f"; else note WARN "Skipped an /etc/cron.d file with an unusual name"; fi
    done
  fi
else
  note UNAVAILABLE:crontabs "reading user crontabs $NEEDROOT"
fi

if command -v ss >/dev/null 2>&1; then
  if ss -H -tulpn >"$W/ss" 2>/dev/null || ss -tulpn >"$W/ss" 2>/dev/null; then
    emit PORTS; head -c ${FILE_CAP} "$W/ss" | b64
  else
    note UNAVAILABLE:ports "ss failed on this host"
  fi
else
  note UNAVAILABLE:ports "ss (iproute2) is not installed"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl list-unit-files --state=enabled --no-legend --no-pager >"$W/units" 2>/dev/null
  rc=$?
  if [ -s "$W/units" ] || [ "$rc" = 0 ]; then
    emit UNITS; head -c ${FILE_CAP} "$W/units" | b64
  else
    note UNAVAILABLE:units "systemctl could not list unit files (systemd is not running)"
  fi
else
  note UNAVAILABLE:units "systemctl is not available (not a systemd host)"
fi

if [ "$ROOT" = 1 ]; then
  emit AKEYS; echo
  pw | while IFS=: read -r n _ _ _ _ h _; do
    safe_name "$n" || continue
    case "$h" in /*) ;; *) continue ;; esac
    for k in "$h/.ssh/authorized_keys" "$h/.ssh/authorized_keys2"; do
      [ -f "$k" ] || continue
      emit "AK:$n"
      grep -E '(^|[[:space:]])(ssh|ecdsa|sk)-' "$k" 2>/dev/null | head -c ${KEYS_CAP} | b64
    done
  done
else
  note UNAVAILABLE:authorized_keys "reading other users' authorized_keys $NEEDROOT"
fi

emit END; echo
`;

export class DriftCollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftCollectError";
  }
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

interface Block {
  kind: string;
  name: string;
  payload: string;
}

const HEADER_PATTERN = /^===([A-Z_]+)(?::(.*))?===$/;
const B64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function parseDriftBlocks(stdout: string): Block[] {
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

function decodeBuffer(payload: string): Buffer | null {
  if (!B64_PATTERN.test(payload)) return null;
  return Buffer.from(payload, "base64");
}

function decodeText(payload: string): string | null {
  return decodeBuffer(payload)?.toString("utf8") ?? null;
}

// ---------------------------------------------------------------------------
// Category parsers (exported for tests)
// ---------------------------------------------------------------------------

export function parsePasswd(text: string): DriftUser[] {
  const seen = new Map<string, DriftUser>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || /^[#+-]/.test(line)) continue;
    const f = line.split(":");
    if (f.length < 7) continue;
    const name = f[0]!;
    const uid = Number.parseInt(f[2]!, 10);
    const gid = Number.parseInt(f[3]!, 10);
    if (!name || !Number.isFinite(uid) || !Number.isFinite(gid) || seen.has(name)) continue;
    seen.set(name, { name, uid, gid, home: f[5] ?? "", shell: f.slice(6).join(":") });
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function parseGroupFile(text: string): Map<string, { gid: number; members: string[] }> {
  const out = new Map<string, { gid: number; members: string[] }>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || /^[#+-]/.test(line)) continue;
    const f = line.split(":");
    if (f.length < 3) continue;
    const name = f[0]!;
    const gid = Number.parseInt(f[2]!, 10);
    if (!name || !Number.isFinite(gid) || out.has(name)) continue;
    const members = (f[3] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    out.set(name, { gid, members });
  }
  return out;
}

/**
 * Normalized sudoers rules: continuation lines joined, whitespace collapsed,
 * comments, blank lines and `Defaults…` lines dropped. `#include`/`#includedir`
 * are directives, not comments, and are kept (so is `@include…`).
 */
export function parseSudoers(text: string): string[] {
  const logical: string[] = [];
  let buf = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.endsWith("\\")) {
      buf += `${line.slice(0, -1)} `;
      continue;
    }
    logical.push(buf + line);
    buf = "";
  }
  if (buf) logical.push(buf);
  const rules = new Set<string>();
  for (const l of logical) {
    const t = l.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (t.startsWith("#") && !/^#include(?:dir)? /.test(t)) continue;
    if (/^Defaults(?:[\s:@>!]|$)/.test(t)) continue;
    rules.add(t);
  }
  return [...rules].sort();
}

/**
 * Privileged groups (PRIVILEGED_OS_GROUPS) plus every `%group` sudoers grants
 * rights to, with explicit members AND users whose primary gid is the group —
 * `useradd -g sudo` never shows up in the group's member list.
 */
export function buildGroups(
  groupFile: Map<string, { gid: number; members: string[] }>,
  users: readonly DriftUser[],
  sudoers: readonly string[] | null,
): Record<string, DriftGroup> {
  const wanted = new Set<string>(PRIVILEGED_OS_GROUPS);
  if (sudoers) for (const g of sudoersSubjects(sudoers).groups) wanted.add(g);
  const out: Record<string, DriftGroup> = {};
  for (const name of [...wanted].sort()) {
    const g = groupFile.get(name);
    if (!g) continue;
    const members = new Set(g.members);
    for (const u of users) if (u.gid === g.gid) members.add(u.name);
    out[name] = { gid: g.gid, members: [...members].sort() };
  }
  return out;
}

/** First port of the Linux default ephemeral range (net.ipv4.ip_local_port_range). */
const EPHEMERAL_PORT_MIN = 32_768;

/**
 * `ss -tulpn` → listening sockets. Pids and fds are stripped, and ports in the
 * ephemeral range collapse to `addr:ephemeral` — DHCP clients, avahi, rpc.statd
 * and friends bind a random high port on every start, which would otherwise be
 * "new listening port" noise after each reboot. A different process appearing
 * on a collapsed entry still shows as a change.
 */
export function parsePorts(text: string, withProcesses: boolean): DriftPort[] {
  const byKey = new Map<string, { proto: string; local: string; procs: Set<string> }>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^(?:Netid|State)\s/.test(line)) continue;
    const t = line.split(/\s+/);
    if (t.length < 5) continue;
    const proto = t[0]!.toLowerCase();
    const local = t[4]!;
    const colon = local.lastIndexOf(":");
    if (colon <= 0) continue;
    const host = local.slice(0, colon);
    const portText = local.slice(colon + 1);
    const port = Number.parseInt(portText, 10);
    const normalized = Number.isFinite(port) && port >= EPHEMERAL_PORT_MIN ? `${host}:ephemeral` : `${host}:${portText}`;
    const key = `${proto} ${normalized}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { proto, local: normalized, procs: new Set() };
      byKey.set(key, entry);
    }
    if (withProcesses) {
      for (const m of line.matchAll(/\("([^"]*)",/g)) if (m[1]) entry.procs.add(m[1]);
    }
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, e]) => ({
      proto: e.proto,
      local: e.local,
      process: withProcesses && e.procs.size > 0 ? [...e.procs].sort().join(",") : null,
    }));
}

const UNIT_PATTERN = /^[A-Za-z0-9@:._\\-]+\.(?:service|socket|timer|target|path|mount|automount|swap|slice|scope|device)$/;

export function parseUnits(text: string): string[] {
  const units = new Set<string>();
  for (const raw of text.split("\n")) {
    const first = raw.trim().split(/\s+/)[0] ?? "";
    if (UNIT_PATTERN.test(first)) units.add(first);
  }
  return [...units].sort();
}

const KEY_TYPE_PATTERN = /^(?:ssh|ecdsa|sk)-[A-Za-z0-9@._+-]+$/;
const KEY_BLOB_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** The part of an authorized_keys line after its options (sshd's own rule: quotes may contain spaces). */
function stripKeyOptions(line: string): string {
  const firstToken = line.split(/\s+/)[0] ?? "";
  if (KEY_TYPE_PATTERN.test(firstToken)) return line;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && inQuote) {
      i++;
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && (ch === " " || ch === "\t")) return line.slice(i).trim();
  }
  return "";
}

/** `SHA256:<base64, no padding>` of the decoded key blob — what `ssh-keygen -lf` prints. */
export function sshKeyFingerprint(blobBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(blobBase64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export function parseAuthorizedKeys(text: string): DriftAuthorizedKey[] {
  const out = new Map<string, DriftAuthorizedKey>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line.startsWith("#")) continue;
    const rest = stripKeyOptions(line);
    const [type = "", blob = "", ...comment] = rest.split(" ");
    let key: DriftAuthorizedKey;
    if (KEY_TYPE_PATTERN.test(type) && KEY_BLOB_PATTERN.test(blob) && Buffer.from(blob, "base64").length >= 4) {
      key = { fp: sshKeyFingerprint(blob), type, comment: comment.join(" ").slice(0, 200) };
    } else {
      // Not a key ssh-keygen could read either; still track the line itself.
      key = { fp: `LINE:${sha256Hex(line)}`, type: "unparsed", comment: "" };
    }
    if (!out.has(key.fp)) out.set(key.fp, key);
  }
  return [...out.values()].sort((a, b) => (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Whole output
// ---------------------------------------------------------------------------

const CATEGORY_SET = new Set<string>(DRIFT_CATEGORIES);
const CRON_TARGET_PATTERN = /^(?:system|user:[A-Za-z0-9_.][A-Za-z0-9_.-]*|crond:[A-Za-z0-9_.][A-Za-z0-9_.-]*)$/;
const USER_NAME_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

export function parseDriftOutput(stdout: string): DriftSnapshotData {
  const blocks = parseDriftBlocks(stdout);
  const fatal = blocks.find((b) => b.kind === "FATAL");
  if (fatal) throw new DriftCollectError(`The drift scan could not run on the host (${fatal.name || "unknown error"})`);
  if (!blocks.some((b) => b.kind === "END")) {
    throw new DriftCollectError("The drift scan output was incomplete (the script did not finish)");
  }

  const unavailable: Partial<Record<DriftCategory, string>> = {};
  const warnings: string[] = [];
  let ranAsRoot = false;
  let passwdText: string | null = null;
  let groupText: string | null = null;
  let sudoers: string[] | null = null;
  let crontabs: Record<string, string> | null = null;
  let ports: DriftPort[] | null = null;
  let portsText: string | null = null;
  let units: string[] | null = null;
  let authorizedKeys: Record<string, DriftAuthorizedKey[]> | null = null;

  for (const b of blocks) {
    switch (b.kind) {
      case "ROOT":
        ranAsRoot = b.payload === "1";
        break;
      case "PASSWD":
        passwdText = decodeText(b.payload);
        break;
      case "GROUP":
        groupText = decodeText(b.payload);
        break;
      case "SUDOERS": {
        const t = decodeText(b.payload);
        if (t === null) unavailable.sudoers = "the host sent unreadable sudoers output";
        else sudoers = parseSudoers(t);
        break;
      }
      case "CRONTABS":
        crontabs = {};
        break;
      case "CRONH":
      case "CRONB": {
        if (!crontabs || !CRON_TARGET_PATTERN.test(b.name)) break;
        if (b.kind === "CRONH") {
          if (/^[a-f0-9]{64}$/.test(b.payload)) crontabs[b.name] = b.payload;
          else warnings.push(`Could not hash ${b.name}`);
        } else {
          const buf = decodeBuffer(b.payload);
          if (buf) crontabs[b.name] = sha256Hex(buf);
          else warnings.push(`Could not read ${b.name}`);
        }
        break;
      }
      case "PORTS":
        portsText = decodeText(b.payload);
        break;
      case "UNITS": {
        const t = decodeText(b.payload);
        if (t !== null) units = parseUnits(t);
        break;
      }
      case "AKEYS":
        authorizedKeys = {};
        break;
      case "AK": {
        if (!authorizedKeys || !USER_NAME_PATTERN.test(b.name)) break;
        const t = decodeText(b.payload);
        if (t === null) break;
        const keys = parseAuthorizedKeys(t);
        if (keys.length === 0) break;
        const merged = new Map((authorizedKeys[b.name] ?? []).map((k) => [k.fp, k]));
        for (const k of keys) if (!merged.has(k.fp)) merged.set(k.fp, k);
        authorizedKeys[b.name] = [...merged.values()].sort((x, y) => (x.fp < y.fp ? -1 : x.fp > y.fp ? 1 : 0));
        break;
      }
      case "UNAVAILABLE":
        if (CATEGORY_SET.has(b.name)) unavailable[b.name as DriftCategory] = decodeText(b.payload)?.slice(0, 300) || "not available";
        break;
      case "WARN": {
        const t = decodeText(b.payload);
        if (t) warnings.push(t.slice(0, 300));
        break;
      }
    }
  }

  if (portsText !== null) ports = parsePorts(portsText, ranAsRoot);

  // An empty account database is a failed read, never "every account was removed".
  let users: DriftUser[] | null = passwdText !== null ? parsePasswd(passwdText) : null;
  if (users && users.length === 0) users = null;
  if (!users) unavailable.users ??= "the account database (getent passwd) could not be read";

  const groupFile = groupText !== null ? parseGroupFile(groupText) : null;
  let groups: Record<string, DriftGroup> | null = null;
  if (!groupFile || groupFile.size === 0) unavailable.groups ??= "the group database (getent group) could not be read";
  else if (!users) unavailable.groups ??= "needs the account database, which could not be read";
  else groups = buildGroups(groupFile, users, sudoers);

  const data: DriftSnapshotData = {
    v: 1,
    ranAsRoot,
    users,
    groups,
    sudoers: unavailable.sudoers ? null : sudoers,
    crontabs: unavailable.crontabs ? null : crontabs,
    ports: unavailable.ports ? null : ports,
    units: unavailable.units ? null : units,
    authorizedKeys: unavailable.authorized_keys ? null : authorizedKeys,
    unavailable,
    warnings: warnings.slice(0, 50),
  };
  // A category the host neither reported nor explained is unavailable too.
  const reported: Record<DriftCategory, unknown> = {
    users: data.users,
    groups: data.groups,
    sudoers: data.sudoers,
    crontabs: data.crontabs,
    ports: data.ports,
    units: data.units,
    authorized_keys: data.authorizedKeys,
  };
  for (const c of DRIFT_CATEGORIES) if (reported[c] === null) unavailable[c] ??= "not reported by the host";
  return data;
}
