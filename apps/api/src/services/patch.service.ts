import pLimit, { type LimitFunction } from "p-limit";
import type { Prisma, ServerPatchStatus } from "@prisma/client";
import {
  PATCH_PACKAGE_MANAGERS,
  PATCH_PACKAGES_MAX,
  PATCH_SCAN_STATUSES,
  type PatchApplyMode,
  type PatchApplyResponse,
  type PatchFleetRow,
  type PatchListQuery,
  type PatchListResponse,
  type PatchPackage,
  type PatchPackageManager,
  type PatchScanStatus,
  type PatchSummary,
  type ServerPatchStatusDto,
} from "@inv/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";
import type { AuditCtx } from "../lib/audit.js";
import { writeAudit } from "../lib/audit.js";
import { AppError, notFound } from "../lib/errors.js";
import { emitAlert, type AlertEventInput } from "./alerting/emit.js";
import { connectToServer, SshError, sshErrorToHttp } from "./ssh.service.js";
import {
  describeRemoteFailure,
  execAsRoot,
  execPreferRoot,
  RemoteFailureError,
  remoteFailureToHttp,
  type RemoteScriptResult,
} from "./remote-exec.service.js";

/**
 * Fleet patch management.
 *
 * A scan is ONE read-only script run through execPreferRoot (root when sudo
 * works, otherwise as the SSH user). It detects the package manager, lists
 * pending updates and security updates, and reports the reboot-required flag,
 * the running kernel and the newest installed one. Its stdout is a sequence of
 * `===KIND[:NAME]===` header lines, each value header followed by ONE base64
 * line, so nothing the host prints can be mistaken for a marker.
 *
 * Applying updates runs the distribution's own tool as root (execAsRoot) and
 * never reboots. Security-only on apt means unattended-upgrades; it is refused,
 * not emulated, when that is not installed.
 *
 * Alerts are edge-triggered off the stored row: patch_available when the
 * security count goes 0 → >0 (resolved when it is back to 0), reboot_required
 * when the flag flips on (resolved when it flips off). A failed scan keeps the
 * counts of the last good one and never moves an alert.
 */

const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
/** Package-index refresh inside the scan, bounded on the host with `timeout`. */
const REFRESH_TIMEOUT_SEC = 150;
const SCAN_OUTPUT_CAP = 16 * 1024 * 1024;
const APPLY_TIMEOUT_MS = 30 * 60 * 1000;
/** Tail of the package manager's combined output returned by an apply. */
const APPLY_OUTPUT_TAIL_BYTES = 256 * 1024;
const APPLY_STDOUT_CAP = 1024 * 1024;
const MAX_TEXT = 200;
const MAX_ERROR = 1000;

type Conn = Awaited<ReturnType<typeof connectToServer>>;

interface ServerRef {
  id: number;
  hostname: string;
  environment: string | null;
}

/** The host answered, but not in a way RackMap can use. Mapped to 502. */
export class PatchHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchHostError";
  }
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
val() { emit "$1"; printf '%s' "$2" | b64; }
emit_head() { emit "$1"; if [ -f "$2" ]; then head -c "$3" "$2" | b64; else echo; fi; }
emit_tail() { emit "$1"; if [ -f "$2" ]; then tail -c "$3" "$2" | b64; else echo; fi; }
with_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }
detect_pm() {
  if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then PM=apt
  elif command -v dnf >/dev/null 2>&1; then PM=dnf
  elif command -v yum >/dev/null 2>&1; then PM=yum
  elif command -v zypper >/dev/null 2>&1; then PM=zypper
  else PM=unknown
  fi
}
`;

/**
 * The read-only scan. `refresh` re-downloads the package index first, and only
 * when the script really runs as root (a non-root refresh would either fail or
 * fill a per-user cache).
 */
export function buildPatchScanScript(opts: { refresh: boolean }): string {
  return `${PRELUDE}
REFRESH=${opts.refresh ? 1 : 0}
U=$(id -u 2>/dev/null)
val ROOT "$U"
val OS "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1)"
val KRUN "$(uname -r 2>/dev/null)"
KB=$(ls -1 /boot 2>/dev/null | sed -n 's/^vmlinuz-//p')
[ -n "$KB" ] || KB=$(ls -1 /lib/modules 2>/dev/null)
val KINST "$KB"
detect_pm
val PM "$PM"
RF=skipped
if [ "$REFRESH" = 1 ]; then
  if [ "$U" = 0 ]; then
    rc=0
    case "$PM" in
      apt) with_timeout ${REFRESH_TIMEOUT_SEC} apt-get -q update -o DPkg::Lock::Timeout=60 >"$W/r" 2>&1 || rc=$? ;;
      dnf|yum) with_timeout ${REFRESH_TIMEOUT_SEC} "$PM" -q makecache >"$W/r" 2>&1 || rc=$? ;;
      zypper) with_timeout ${REFRESH_TIMEOUT_SEC} zypper -n -q refresh >"$W/r" 2>&1 || rc=$? ;;
    esac
    if [ "$rc" = 0 ]; then RF=ok; else RF=failed; fi
  else
    RF=noroot
  fi
fi
val REFRESH "$RF"
emit_tail REFRESHLOG "$W/r" 600
URC=
SRC=
case "$PM" in
  apt)
    apt list --upgradable >"$W/u" 2>"$W/ue"; URC=$?
    ;;
  dnf|yum)
    "$PM" -q check-update >"$W/u" 2>"$W/ue"; URC=$?
    "$PM" -q updateinfo list --security >"$W/s" 2>"$W/se"; SRC=$?
    if [ "$URC" = 100 ] && command -v rpm >/dev/null 2>&1; then
      rpm -qa --qf '%{NAME}.%{ARCH} %|EPOCH?{%{EPOCH}:}:{}|%{VERSION}-%{RELEASE}\\n' >"$W/i" 2>/dev/null
    fi
    ;;
  zypper)
    ZR=
    [ "$U" = 0 ] || ZR=--no-refresh
    zypper -n $ZR lu >"$W/u" 2>"$W/ue"; URC=$?
    zypper -n $ZR lp -g security >"$W/s" 2>"$W/se"; SRC=$?
    ;;
esac
val URC "$URC"
emit_head UPG "$W/u" 4194304
emit_tail UPGERR "$W/ue" 1000
val SRC "$SRC"
emit_head SEC "$W/s" 2097152
emit_tail SECERR "$W/se" 1000
emit_head INST "$W/i" 4194304
RB=unknown
if [ -e /var/run/reboot-required ] || [ -e /run/reboot-required ] || [ -e /run/reboot-needed ]; then
  RB=yes
else
  r=
  case "$PM" in
    apt)
      [ -e /usr/share/update-notifier/notify-reboot-required ] && RB=no
      ;;
    dnf|yum)
      if command -v needs-restarting >/dev/null 2>&1; then
        needs-restarting -r >/dev/null 2>&1; r=$?
      elif [ "$PM" = dnf ] && dnf -q needs-restarting --help >/dev/null 2>&1; then
        dnf -q needs-restarting -r >/dev/null 2>&1; r=$?
      fi
      case "$r" in 0) RB=no ;; 1) RB=yes ;; esac
      ;;
    zypper)
      zypper -n needs-rebooting >/dev/null 2>&1; r=$?
      case "$r" in 0) RB=no ;; 102) RB=yes ;; esac
      ;;
  esac
fi
val REBOOT "$RB"
emit END
`;
}

/** What each mode runs, per package manager (shown to the operator and audited). */
export function patchApplyCommand(pm: PatchPackageManager, mode: PatchApplyMode): string | null {
  switch (pm) {
    case "apt":
      return mode === "security"
        ? "apt-get update && unattended-upgrade -v"
        : "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold dist-upgrade";
    case "dnf":
    case "yum":
      return mode === "security" ? `${pm} -y upgrade --security` : `${pm} -y upgrade`;
    case "zypper":
      return mode === "security" ? "zypper -n patch -g security" : "zypper -n update";
    default:
      return null;
  }
}

/**
 * Apply pending updates as root. Everything the package manager prints goes to
 * a private file; its tail comes back base64-encoded after the exit code, so a
 * huge dist-upgrade log cannot push the result out of the capture. Never reboots.
 */
export function buildPatchApplyScript(mode: PatchApplyMode): string {
  if (mode !== "security" && mode !== "all") throw new AppError("VALIDATION_ERROR", "Invalid mode", 400);
  // Display strings only (single-quoted in the script; they contain no quotes).
  const cmd = (pm: PatchPackageManager) => patchApplyCommand(pm, mode)!.replace(/'/g, "");
  const dnfArgs = mode === "security" ? "-y upgrade --security" : "-y upgrade";
  const zypperRun =
    mode === "security"
      ? `n=0
    while :; do
      zypper -n patch -g security >>"$W/o" 2>&1; RC=$?
      n=$((n + 1))
      [ "$RC" = 103 ] && [ "$n" -lt 3 ] || break
    done`
      : `zypper -n update >>"$W/o" 2>&1; RC=$?`;
  const aptRun =
    mode === "security"
      ? `if ! command -v unattended-upgrade >/dev/null 2>&1; then emit REFUSED:NO_UNATTENDED_UPGRADE; emit END; exit 0; fi
    val CMD '${cmd("apt")}'
    emit STARTED
    apt-get -q update -o DPkg::Lock::Timeout=300 >>"$W/o" 2>&1
    unattended-upgrade -v >>"$W/o" 2>&1; RC=$?`
      : `val CMD '${cmd("apt")}'
    emit STARTED
    apt-get -q update -o DPkg::Lock::Timeout=300 >>"$W/o" 2>&1
    apt-get -y -o Dpkg::Options::=--force-confold -o DPkg::Lock::Timeout=300 dist-upgrade >>"$W/o" 2>&1; RC=$?`;
  return `${PRELUDE}
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
detect_pm
val PM "$PM"
: >"$W/o"
RC=
case "$PM" in
  apt)
    ${aptRun}
    ;;
  dnf|yum)
    val CMD "$PM ${dnfArgs}"
    emit STARTED
    "$PM" ${dnfArgs} >>"$W/o" 2>&1; RC=$?
    ;;
  zypper)
    val CMD '${cmd("zypper")}'
    emit STARTED
    ${zypperRun}
    ;;
  *)
    emit REFUSED:UNSUPPORTED
    emit END
    exit 0
    ;;
esac
val RC "$RC"
val OUTSIZE "$(wc -c <"$W/o" | tr -d ' ')"
emit_tail OUT "$W/o" ${APPLY_OUTPUT_TAIL_BYTES}
emit END
`;
}

// ---------------------------------------------------------------------------
// Output protocol
// ---------------------------------------------------------------------------

interface Block {
  kind: string;
  name: string;
  payload: string;
}

const HEADER_PATTERN = /^===([A-Z]+)(?::([A-Z0-9_]*))?===$/;
const B64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function parsePatchBlocks(stdout: string): Block[] {
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

function decode(payload: string | undefined): string {
  if (!payload || !B64_PATTERN.test(payload)) return "";
  return Buffer.from(payload, "base64").toString("utf8").replace(/\u0000/g, "");
}

function blockMap(blocks: Block[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of blocks) map.set(b.kind, decode(b.payload));
  return map;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Last few non-empty lines of a stderr capture, for an operator-facing message. */
function lastLines(text: string, n = 3): string {
  return clip(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-n)
      .join(" "),
    400,
  );
}

function fatalMessage(code: string): string {
  switch (code) {
    case "NO_BASE64":
      return "The host has no base64 command (coreutils/busybox), which the patch scan needs";
    case "MKTEMP":
      return "Could not create a temporary directory on the host";
    default:
      return `The patch script failed on the host (${code || "unknown"})`;
  }
}

// ---------------------------------------------------------------------------
// Parsers (pure; exported for tests)
// ---------------------------------------------------------------------------

export interface ParsedPackage extends PatchPackage {
  arch?: string;
}

const APT_LINE = /^([^\s/]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*([^\]]+)\]/;

/** `apt list --upgradable`: `name/suite[,suite] version arch [upgradable from: old]`. */
export function parseAptUpgradable(text: string): ParsedPackage[] {
  const out: ParsedPackage[] = [];
  for (const raw of text.split("\n")) {
    const m = APT_LINE.exec(raw.trim());
    if (!m) continue;
    const suites = m[2]!.split(",");
    out.push({
      name: m[1]!,
      current: m[5]!.trim() || null,
      available: m[3]!,
      arch: m[4]!,
      // Security updates come from a suite such as jammy-security / bookworm-security.
      security: suites.some((s) => s.includes("-security")),
    });
  }
  return out;
}

const RPM_ARCHES = new Set([
  "x86_64",
  "noarch",
  "i686",
  "i586",
  "i386",
  "aarch64",
  "ppc64le",
  "ppc64",
  "s390x",
  "armv7hl",
  "armhfp",
  "riscv64",
  "src",
]);
const NAME_ARCH = /^(.+)\.([A-Za-z0-9_]+)$/;

/**
 * `dnf|yum check-update`: `name.arch  version  repo`. yum wraps a long name onto
 * its own line with the rest indented below, so short rows are joined with the
 * indented continuation. Everything after "Obsoleting Packages" is ignored.
 */
export function parseRpmCheckUpdate(text: string): { name: string; arch: string; available: string }[] {
  const out: { name: string; arch: string; available: string }[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length === 3) {
      const m = NAME_ARCH.exec(pending[0]!);
      if (m && RPM_ARCHES.has(m[2]!) && /^\d/.test(pending[1]!)) {
        out.push({ name: m[1]!, arch: m[2]!, available: pending[1]! });
      }
    }
    pending = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (/^Obsoleting Packages/i.test(trimmed)) break;
    if (!trimmed) {
      flush();
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    if (/^\s/.test(line) && pending.length > 0 && pending.length < 3) {
      pending.push(...tokens);
      continue;
    }
    flush();
    pending = tokens;
  }
  flush();
  return out;
}

const NEVRA = /^(.+)-([^-]+)-([^-]+)\.([A-Za-z0-9_]+)$/;

/**
 * `dnf|yum updateinfo list --security` (dnf 4: `ADVISORY Sev/Sec. NEVRA`; dnf 5:
 * a table with a Package column). Returns the `name.arch` of every package an
 * advisory names.
 */
export function parseRpmSecurityList(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    for (const tok of line.trim().split(/\s+/)) {
      const m = NEVRA.exec(tok);
      if (m && RPM_ARCHES.has(m[4]!)) names.add(`${m[1]}.${m[4]}`);
    }
  }
  return names;
}

/** `rpm -qa --qf '%{NAME}.%{ARCH} [E:]V-R'` → newest installed version per name.arch. */
export function parseRpmInstalled(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const [key, version] = raw.trim().split(/\s+/);
    if (!key || !version) continue;
    const prev = map.get(key);
    if (!prev || compareVersions(version, prev) > 0) map.set(key, version);
  }
  return map;
}

/** zypper's `|`-separated tables → rows keyed by lower-cased header. */
export function parseZypperTable(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let header: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.includes("|")) continue;
    if (/^[-+|\s]+$/.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (!header) {
      if (cells.some((c) => /^name$/i.test(c))) header = cells.map((c) => c.toLowerCase());
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/** `zypper lu` → packages (zypper reports security per patch, not per package). */
export function parseZypperUpdates(text: string): ParsedPackage[] {
  return parseZypperTable(text)
    .filter((r) => r["name"] && r["available version"])
    .map((r) => ({
      name: r["name"]!,
      current: r["current version"] || null,
      available: r["available version"]!,
      arch: r["arch"] || undefined,
      security: false,
    }));
}

/** `zypper lp -g security` → number of needed security patches. */
export function countZypperSecurityPatches(text: string): number {
  const seen = new Set<string>();
  for (const r of parseZypperTable(text)) {
    if (!r["name"]) continue;
    if (r["category"] !== undefined && !/security/i.test(r["category"])) continue;
    if (r["status"] !== undefined && r["status"] !== "" && !/needed|applicable/i.test(r["status"])) continue;
    seen.add(r["name"]);
  }
  return seen.size;
}

/**
 * Version order good enough to pick the newest kernel: numeric runs compare as
 * numbers, alphabetic runs as strings, and a number sorts after a word (the
 * rpmvercmp convention). Separators are ignored.
 */
export function compareVersions(a: string, b: string): number {
  const ta = a.match(/\d+|[A-Za-z]+/g) ?? [];
  const tb = b.match(/\d+|[A-Za-z]+/g) ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = BigInt(x) - BigInt(y);
      if (d !== 0n) return d > 0n ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? 1 : -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The flavour a kernel release belongs to: Debian/Ubuntu/SUSE put it after the
 * ABI number ("-generic", "-cloud-amd64", "-default"); rpm kernels end in the
 * arch (".x86_64", ".x86_64+debug"). Only kernels of the running flavour are
 * compared, so a -lowlatency image never makes a -generic host look behind.
 */
export function kernelFlavour(release: string): string {
  const deb = /^\d+(?:\.\d+)*-\d+(?:\.\d+)*-(.+)$/.exec(release);
  if (deb) return `-${deb[1]}`;
  const rpm = /\.[A-Za-z0-9_]+(?:\+[A-Za-z0-9]+)?$/.exec(release);
  return rpm ? rpm[0] : "";
}

/** Newest installed kernel of the running kernel's flavour (all of them when none match). */
export function newestKernel(running: string | null, installed: string[]): string | null {
  const candidates = installed
    .map((k) => k.trim())
    .filter((k) => k && /^\d/.test(k) && !/rescue/i.test(k));
  if (candidates.length === 0) return null;
  const flavour = running ? kernelFlavour(running) : "";
  const same = flavour ? candidates.filter((k) => kernelFlavour(k) === flavour) : [];
  const pool = same.length > 0 ? same : candidates;
  return pool.reduce((best, k) => (compareVersions(k, best) > 0 ? k : best));
}

export function isKernelNewer(latest: string | null, running: string | null): boolean {
  return !!latest && !!running && compareVersions(latest, running) > 0;
}

function isPackageManager(v: unknown): v is PatchPackageManager {
  return typeof v === "string" && (PATCH_PACKAGE_MANAGERS as readonly string[]).includes(v);
}

function isScanStatus(v: unknown): v is PatchScanStatus {
  return typeof v === "string" && (PATCH_SCAN_STATUSES as readonly string[]).includes(v);
}

/** Security first, then by name; capped for storage. */
function displayPackages(pkgs: ParsedPackage[]): PatchPackage[] {
  return [...pkgs]
    .sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name))
    .slice(0, PATCH_PACKAGES_MAX)
    .map((p) => ({
      name: clip(p.name, MAX_TEXT),
      current: p.current ? clip(p.current, MAX_TEXT) : null,
      available: clip(p.available, MAX_TEXT),
      security: p.security,
    }));
}

export interface ParsedPatchScan {
  status: PatchScanStatus;
  /** Reason for status "error"/"unsupported"; a warning with status "ok". */
  error: string | null;
  packageManager: PatchPackageManager | null;
  osPretty: string | null;
  kernelRunning: string | null;
  kernelLatest: string | null;
  rebootRequired: boolean;
  upgradableCount: number;
  securityCount: number;
  packages: PatchPackage[];
  ranAsRoot: boolean;
}

function errorScan(message: string, partial: Partial<ParsedPatchScan> = {}): ParsedPatchScan {
  return {
    packageManager: null,
    osPretty: null,
    kernelRunning: null,
    kernelLatest: null,
    rebootRequired: false,
    upgradableCount: 0,
    securityCount: 0,
    packages: [],
    ranAsRoot: false,
    ...partial,
    status: "error",
    error: clip(message, MAX_ERROR),
  };
}

/** Turn scan-script output into a ServerPatchStatus shape. Never throws. */
export function parsePatchScanOutput(stdout: string): ParsedPatchScan {
  const blocks = parsePatchBlocks(stdout);
  const fatal = blocks.find((b) => b.kind === "FATAL");
  if (fatal) return errorScan(fatalMessage(fatal.name));
  const v = blockMap(blocks);

  const osRaw = (v.get("OS") ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  const kernelRunning = clip((v.get("KRUN") ?? "").trim(), MAX_TEXT) || null;
  const kernelLatest = newestKernel(kernelRunning, (v.get("KINST") ?? "").split("\n"));
  const pmRaw = (v.get("PM") ?? "").trim();
  const base = {
    packageManager: isPackageManager(pmRaw) ? pmRaw : null,
    osPretty: clip(osRaw, MAX_TEXT) || null,
    kernelRunning,
    kernelLatest: kernelLatest ? clip(kernelLatest, MAX_TEXT) : null,
    ranAsRoot: (v.get("ROOT") ?? "").trim() === "0",
  };
  if (!blocks.some((b) => b.kind === "END")) {
    return errorScan("Incomplete output from the host while scanning for updates", base);
  }
  const pm = base.packageManager;
  if (!pm || pm === "unknown") {
    return {
      ...base,
      packageManager: "unknown",
      status: "unsupported",
      error: "No supported package manager (apt, dnf, yum or zypper) was found on this host",
      rebootRequired: false,
      upgradableCount: 0,
      securityCount: 0,
      packages: [],
    };
  }

  const warnings: string[] = [];
  const refresh = (v.get("REFRESH") ?? "").trim();
  if (refresh === "failed") {
    const log = lastLines(v.get("REFRESHLOG") ?? "", 2);
    warnings.push(`The package index could not be refreshed, so results may be stale${log ? `: ${log}` : ""}`);
  } else if (refresh === "noroot") {
    warnings.push("Scanned without root (sudo is not available), so the package index was not refreshed");
  }

  const urc = (v.get("URC") ?? "").trim();
  const src = (v.get("SRC") ?? "").trim();
  const upgErr = lastLines(v.get("UPGERR") ?? "");
  let pkgs: ParsedPackage[] = [];
  let securityCount = 0;

  if (pm === "apt") {
    if (urc !== "0") return errorScan(`apt list --upgradable failed (exit ${urc || "?"})${upgErr ? `: ${upgErr}` : ""}`, base);
    pkgs = parseAptUpgradable(v.get("UPG") ?? "");
    securityCount = pkgs.filter((p) => p.security).length;
  } else if (pm === "dnf" || pm === "yum") {
    if (urc !== "0" && urc !== "100") {
      return errorScan(`${pm} check-update failed (exit ${urc || "?"})${upgErr ? `: ${upgErr}` : ""}`, base);
    }
    const rows = urc === "100" ? parseRpmCheckUpdate(v.get("UPG") ?? "") : [];
    if (urc === "100" && rows.length === 0) {
      return errorScan(`${pm} check-update reported updates but its output could not be parsed`, base);
    }
    const installed = parseRpmInstalled(v.get("INST") ?? "");
    let secNames = new Set<string>();
    if (src === "0") {
      secNames = parseRpmSecurityList(v.get("SEC") ?? "");
    } else {
      const secErr = lastLines(v.get("SECERR") ?? "", 1);
      warnings.push(`Security advisories are not available on this host${secErr ? ` (${secErr})` : ""}`);
    }
    pkgs = rows.map((r) => ({
      name: r.name,
      arch: r.arch,
      current: installed.get(`${r.name}.${r.arch}`) ?? null,
      available: r.available,
      security: secNames.has(`${r.name}.${r.arch}`),
    }));
    securityCount = pkgs.filter((p) => p.security).length;
    // Advisory names that match no check-update row (odd arch naming): count the advisories' packages.
    if (securityCount === 0 && secNames.size > 0 && rows.length > 0) securityCount = Math.min(secNames.size, rows.length);
  } else {
    const code = Number(urc);
    if (!/^\d+$/.test(urc) || (code >= 1 && code < 100)) {
      return errorScan(`zypper list-updates failed (exit ${urc || "?"})${upgErr ? `: ${upgErr}` : ""}`, base);
    }
    pkgs = parseZypperUpdates(v.get("UPG") ?? "");
    const scode = Number(src);
    if (/^\d+$/.test(src) && !(scode >= 1 && scode < 100)) {
      securityCount = countZypperSecurityPatches(v.get("SEC") ?? "");
    } else {
      const secErr = lastLines(v.get("SECERR") ?? "", 1);
      warnings.push(`Security patches could not be listed${secErr ? ` (${secErr})` : ""}`);
    }
  }

  const rebootFlag = (v.get("REBOOT") ?? "").trim();
  const kernelPending = isKernelNewer(base.kernelLatest, base.kernelRunning);
  return {
    ...base,
    status: "ok",
    error: warnings.length > 0 ? clip(warnings.join("; "), MAX_ERROR) : null,
    // No definite answer from the host: a newer installed kernel means a reboot is due.
    rebootRequired: rebootFlag === "yes" || (rebootFlag !== "no" && kernelPending),
    upgradableCount: pkgs.length,
    securityCount,
    packages: displayPackages(pkgs),
  };
}

export interface ParsedPatchApply {
  refused?: "NO_UNATTENDED_UPGRADE" | "UNSUPPORTED";
  fatal?: string;
  packageManager: PatchPackageManager | null;
  command: string | null;
  started: boolean;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  complete: boolean;
}

export function parsePatchApplyOutput(stdout: string): ParsedPatchApply {
  const blocks = parsePatchBlocks(stdout);
  const v = blockMap(blocks);
  const pmRaw = (v.get("PM") ?? "").trim();
  const rc = (v.get("RC") ?? "").trim();
  const size = Number((v.get("OUTSIZE") ?? "").trim());
  const refused = blocks.find((b) => b.kind === "REFUSED")?.name;
  const fatal = blocks.find((b) => b.kind === "FATAL")?.name;
  return {
    ...(refused === "NO_UNATTENDED_UPGRADE" || refused === "UNSUPPORTED" ? { refused } : {}),
    ...(fatal !== undefined ? { fatal: fatalMessage(fatal) } : {}),
    packageManager: isPackageManager(pmRaw) ? pmRaw : null,
    command: v.has("CMD") ? v.get("CMD")!.trim() : null,
    started: blocks.some((b) => b.kind === "STARTED"),
    exitCode: /^\d+$/.test(rc) ? Number(rc) : null,
    output: v.get("OUT") ?? "",
    outputTruncated: Number.isFinite(size) && size > APPLY_OUTPUT_TAIL_BYTES,
    complete: blocks.some((b) => b.kind === "END"),
  };
}

/** zypper's 100-103 are informational ("updates/reboot/restart needed"), not failures. */
function applySucceeded(pm: PatchPackageManager | null, exitCode: number | null): boolean {
  if (exitCode === 0) return true;
  return pm === "zypper" && exitCode !== null && exitCode >= 100 && exitCode <= 103;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function normalizePackages(raw: unknown): PatchPackage[] {
  if (!Array.isArray(raw)) return [];
  const out: PatchPackage[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    if (typeof r["name"] !== "string" || typeof r["available"] !== "string") continue;
    out.push({
      name: r["name"],
      current: typeof r["current"] === "string" ? r["current"] : null,
      available: r["available"],
      security: r["security"] === true,
    });
  }
  return out;
}

type PatchRowNoPackages = Omit<ServerPatchStatus, "packages" | "id" | "updatedAt">;

function toSummaryDto(row: PatchRowNoPackages): Omit<ServerPatchStatusDto, "packages"> {
  return {
    serverId: row.serverId,
    packageManager: isPackageManager(row.packageManager) ? row.packageManager : null,
    upgradableCount: row.upgradableCount,
    securityCount: row.securityCount,
    rebootRequired: row.rebootRequired,
    kernelRunning: row.kernelRunning,
    kernelLatest: row.kernelLatest,
    kernelUpdatePending: isKernelNewer(row.kernelLatest, row.kernelRunning),
    osPretty: row.osPretty,
    packagesTruncated: row.upgradableCount > PATCH_PACKAGES_MAX,
    status: isScanStatus(row.status) ? row.status : "error",
    error: row.error,
    scannedAt: row.scannedAt.toISOString(),
    lastAppliedAt: row.lastAppliedAt ? row.lastAppliedAt.toISOString() : null,
  };
}

export function toPatchStatusDto(row: ServerPatchStatus): ServerPatchStatusDto {
  const packages = normalizePackages(row.packages);
  return { ...toSummaryDto(row), packages, packagesTruncated: packages.length < row.upgradableCount };
}

// ---------------------------------------------------------------------------
// Persistence + alerts
// ---------------------------------------------------------------------------

async function loadServer(serverId: number): Promise<ServerRef> {
  const server = await prisma.server.findFirst({
    where: { id: serverId, deletedAt: null },
    select: { id: true, hostname: true, environment: true },
  });
  if (!server) throw notFound("Server");
  return server;
}

export async function getServerPatchStatus(serverId: number): Promise<ServerPatchStatusDto | null> {
  await loadServer(serverId);
  const row = await prisma.serverPatchStatus.findUnique({ where: { serverId } });
  return row ? toPatchStatusDto(row) : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Fire the edge-triggered alerts for a good scan. Never throws. */
async function emitPatchEdges(server: ServerRef, prev: ServerPatchStatus | null, next: ParsedPatchScan): Promise<void> {
  // A previous error row still carries the last good counts; "unsupported" had none.
  const prevSec = prev && prev.status !== "unsupported" ? prev.securityCount : 0;
  const prevReboot = prev && prev.status !== "unsupported" ? prev.rebootRequired : false;
  const common = { serverId: server.id, environment: server.environment };
  const where = next.osPretty ? ` (${next.osPretty})` : "";
  const events: AlertEventInput[] = [];

  if (prevSec === 0 && next.securityCount > 0) {
    const top = next.packages.filter((p) => p.security).slice(0, 10).map((p) => p.name);
    events.push({
      ...common,
      type: "patch_available",
      severity: "warning",
      action: "trigger",
      dedupKey: `rackmap:patch:${server.id}`,
      title: `${server.hostname}: ${plural(next.securityCount, "security update")} available`,
      summary:
        `${plural(next.securityCount, "security update")} (${plural(next.upgradableCount, "update")} in total) ` +
        `pending on ${server.hostname}${where}.${top.length > 0 ? ` Includes: ${top.join(", ")}.` : ""}`,
      payload: {
        securityCount: next.securityCount,
        upgradableCount: next.upgradableCount,
        packageManager: next.packageManager,
        packages: top,
      },
    });
  } else if (prevSec > 0 && next.securityCount === 0) {
    events.push({
      ...common,
      type: "patch_available",
      severity: "info",
      action: "resolve",
      dedupKey: `rackmap:patch:${server.id}`,
      title: `${server.hostname}: no security updates pending`,
      summary: `All security updates are installed on ${server.hostname}${where}.`,
      payload: { securityCount: 0, upgradableCount: next.upgradableCount },
    });
  }

  if (!prevReboot && next.rebootRequired) {
    const kernel =
      next.kernelLatest && next.kernelRunning && next.kernelLatest !== next.kernelRunning
        ? ` Running kernel ${next.kernelRunning}, newest installed ${next.kernelLatest}.`
        : "";
    events.push({
      ...common,
      type: "reboot_required",
      severity: "warning",
      action: "trigger",
      dedupKey: `rackmap:reboot:${server.id}`,
      title: `${server.hostname}: reboot required`,
      summary: `${server.hostname}${where} needs a reboot to finish applying updates.${kernel}`,
      payload: { kernelRunning: next.kernelRunning, kernelLatest: next.kernelLatest },
    });
  } else if (prevReboot && !next.rebootRequired) {
    events.push({
      ...common,
      type: "reboot_required",
      severity: "info",
      action: "resolve",
      dedupKey: `rackmap:reboot:${server.id}`,
      title: `${server.hostname}: reboot no longer required`,
      summary: `${server.hostname}${where} is running its newest kernel.`,
      payload: { kernelRunning: next.kernelRunning },
    });
  }

  for (const e of events) {
    try {
      await emitAlert(e);
    } catch (err) {
      console.error(`[patches] alert ${e.type} for server ${server.id} failed:`, (err as Error).message);
    }
  }
}

/** Store a scan result; alerts only move on a good scan. */
async function storeScan(server: ServerRef, parsed: ParsedPatchScan): Promise<ServerPatchStatusDto> {
  const prev = await prisma.serverPatchStatus.findUnique({ where: { serverId: server.id } });
  const now = new Date();
  let row: ServerPatchStatus;
  if (parsed.status === "error") {
    // Keep the counts of the last good scan; only refresh what this run did learn.
    const known = {
      ...(parsed.packageManager ? { packageManager: parsed.packageManager } : {}),
      ...(parsed.osPretty ? { osPretty: parsed.osPretty } : {}),
      ...(parsed.kernelRunning ? { kernelRunning: parsed.kernelRunning } : {}),
      ...(parsed.kernelLatest ? { kernelLatest: parsed.kernelLatest } : {}),
    };
    row = await prisma.serverPatchStatus.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, ...known, status: "error", error: parsed.error, scannedAt: now },
      update: { ...known, status: "error", error: parsed.error, scannedAt: now },
    });
    return toPatchStatusDto(row);
  }
  const data = {
    packageManager: parsed.packageManager,
    upgradableCount: parsed.upgradableCount,
    securityCount: parsed.securityCount,
    rebootRequired: parsed.rebootRequired,
    kernelRunning: parsed.kernelRunning,
    kernelLatest: parsed.kernelLatest,
    osPretty: parsed.osPretty,
    packages: parsed.packages as unknown as Prisma.InputJsonValue,
    status: parsed.status,
    error: parsed.error,
    scannedAt: now,
  };
  row = await prisma.serverPatchStatus.upsert({
    where: { serverId: server.id },
    create: { serverId: server.id, ...data },
    update: data,
  });
  if (parsed.status === "ok") await emitPatchEdges(server, prev, parsed);
  return toPatchStatusDto(row);
}

function failureMessage(err: unknown): string {
  if (err instanceof SshError) return sshErrorToHttp(err).message;
  if (err instanceof RemoteFailureError || err instanceof PatchHostError || err instanceof AppError) return err.message;
  return (err as { message?: string } | null)?.message || "Patch scan failed";
}

/** Record a scan that never got an answer from the host (unreachable, vault locked, …). */
async function recordFailure(server: ServerRef, err: unknown): Promise<void> {
  if (err instanceof SshError && err.kind === "not_found") return;
  const error = clip(failureMessage(err), MAX_ERROR);
  try {
    await prisma.serverPatchStatus.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, status: "error", error, scannedAt: new Date() },
      update: { status: "error", error, scannedAt: new Date() },
    });
  } catch (dbErr) {
    // The server may have been deleted mid-scan (FK); nothing to record then.
    console.error(`[patches] could not record scan failure for server ${server.id}:`, (dbErr as Error).message);
  }
}

async function openConn(serverId: number, overridePassword?: string): Promise<Conn> {
  return overridePassword ? connectToServer(serverId, overridePassword) : connectToServer(serverId);
}

/** A result that failed around the script (transport, RackMap's sudo, timeout) → thrown. */
function throwIfRemoteFailure(res: RemoteScriptResult, conn: Conn, what: string): void {
  const failure = remoteFailureToHttp(res, { passwordUnavailable: conn.passwordUnavailable });
  if (failure) throw new RemoteFailureError(failure, `${what}: ${failure.message}`);
  if (res.errorCode) throw new PatchHostError(`${what}: ${describeRemoteFailure(res)}`);
}

async function scanOn(conn: Conn, server: ServerRef, refresh: boolean): Promise<ServerPatchStatusDto> {
  let parsed: ParsedPatchScan;
  try {
    const res = await execPreferRoot(conn.client, buildPatchScanScript({ refresh }), conn.password, {
      timeoutMs: SCAN_TIMEOUT_MS,
      maxOutputBytes: SCAN_OUTPUT_CAP,
    });
    throwIfRemoteFailure(res, conn, "Patch scan failed");
    parsed = res.stdoutTruncated
      ? errorScan("The host's package list is too large to load")
      : parsePatchScanOutput(res.stdout);
  } catch (err) {
    await recordFailure(server, err);
    throw err;
  }
  return storeScan(server, parsed);
}

export interface PatchScanOptions {
  /** Refresh the package index first (root only). Default false. */
  refresh?: boolean;
  overridePassword?: string;
}

interface ScanInFlight {
  promise: Promise<ServerPatchStatusDto>;
  refresh: boolean;
  /** Runs on a caller-supplied SSH password: it is never joined and never joins another scan. */
  override: boolean;
}

/** Scans running in THIS process, per server (more than one only when their options differ). */
const scansInFlight = new Map<number, Set<ScanInFlight>>();

function runningScanPromises(): Promise<ServerPatchStatusDto>[] {
  return [...scansInFlight.values()].flatMap((scans) => [...scans].map((s) => s.promise));
}

async function doScan(serverId: number, opts: PatchScanOptions): Promise<ServerPatchStatusDto> {
  const server = await loadServer(serverId);
  let conn: Conn;
  try {
    conn = await openConn(serverId, opts.overridePassword);
  } catch (err) {
    await recordFailure(server, err);
    throw err;
  }
  try {
    return await scanOn(conn, server, opts.refresh ?? false);
  } finally {
    conn.client.end();
  }
}

/**
 * Scan one server and store the result. Host failures are recorded on the row
 * (status "error", previous counts kept) AND thrown, so a route can answer with
 * the right status. A second call while an equivalent scan of the same server
 * is running (same refresh flag, neither on an SSH password override) joins it
 * rather than opening another SSH session; any other call runs its own scan, so
 * a refresh or a supplied password is never answered with another scan's result.
 */
export function scanServerPatches(serverId: number, opts: PatchScanOptions = {}): Promise<ServerPatchStatusDto> {
  const refresh = opts.refresh ?? false;
  const override = Boolean(opts.overridePassword);
  const scans = scansInFlight.get(serverId) ?? new Set<ScanInFlight>();
  if (!override) {
    for (const s of scans) if (!s.override && s.refresh === refresh) return s.promise;
  }
  const scan: ScanInFlight = {
    refresh,
    override,
    promise: doScan(serverId, opts).finally(() => {
      scans.delete(scan);
      if (scans.size === 0) scansInFlight.delete(serverId);
    }),
  };
  scans.add(scan);
  scansInFlight.set(serverId, scans);
  return scan.promise;
}

// ---------------------------------------------------------------------------
// Fleet queue (POST /patches/scan and the scheduler share one limiter)
// ---------------------------------------------------------------------------

let fleetLimit: LimitFunction | undefined;
function limiter(): LimitFunction {
  return (fleetLimit ??= pLimit(env.PATCH_SCAN_CONCURRENCY));
}

const queuedScans = new Set<number>();
const queuedPromises = new Set<Promise<void>>();

/** Queue background scans; returns how many were newly queued (already queued/running ones are skipped). */
export function queuePatchScans(serverIds: number[], opts: Omit<PatchScanOptions, "overridePassword"> = {}): number {
  let queued = 0;
  for (const id of new Set(serverIds)) {
    if (queuedScans.has(id) || scansInFlight.has(id)) continue;
    queuedScans.add(id);
    queued++;
    const p: Promise<void> = limiter()(() => scanServerPatches(id, opts))
      .then(
        () => undefined,
        () => undefined, // recorded on the server's row
      )
      .finally(() => {
        queuedScans.delete(id);
        queuedPromises.delete(p);
      });
    queuedPromises.add(p);
  }
  return queued;
}

/** Scan every id with the fleet limiter and wait; one failing host never stops the rest. */
export async function scanPatchesBatch(
  serverIds: number[],
  opts: Omit<PatchScanOptions, "overridePassword"> = {},
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  await Promise.all(
    serverIds.map((id) =>
      limiter()(() => scanServerPatches(id, opts)).then(
        () => void ok++,
        () => void failed++,
      ),
    ),
  );
  return { ok, failed };
}

/** Scans queued or running in THIS process. */
export function patchScansInProgress(): number {
  return new Set([...queuedScans, ...scansInFlight.keys()]).size;
}

/** Resolves once every queued scan has finished (tests, graceful shutdown). */
export async function waitForPatchScans(): Promise<void> {
  while (queuedPromises.size > 0 || scansInFlight.size > 0) {
    await Promise.allSettled([...queuedPromises, ...runningScanPromises()]);
  }
}

/** Non-deleted servers among `ids` (all non-deleted servers when omitted). */
export async function resolvePatchScanTargets(ids?: number[]): Promise<number[]> {
  const rows = await prisma.server.findMany({
    where: { deletedAt: null, ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const appliesInFlight = new Set<number>();

export interface PatchApplyOptions {
  overridePassword?: string;
}

/**
 * Apply updates as root (30 min limit), rescan on the same connection, stamp
 * lastAppliedAt (only when the run succeeded) and audit. Refuses — before changing anything — security-only
 * on an apt host without unattended-upgrades, and hosts with no known package
 * manager. Never reboots.
 */
export async function applyServerPatches(
  serverId: number,
  input: { mode: PatchApplyMode },
  ctx: AuditCtx,
  opts: PatchApplyOptions = {},
): Promise<PatchApplyResponse> {
  const mode = input.mode;
  if (mode !== "security" && mode !== "all") throw new AppError("VALIDATION_ERROR", "Invalid mode", 400);
  if (appliesInFlight.has(serverId)) {
    throw new AppError("CONFLICT", "Updates are already being applied to this server", 409);
  }
  appliesInFlight.add(serverId);
  try {
    const server = await loadServer(serverId);
    const before = await prisma.serverPatchStatus.findUnique({ where: { serverId } });
    const conn = await openConn(serverId, opts.overridePassword);
    try {
      const res = await execAsRoot(conn.client, buildPatchApplyScript(mode), conn.password, {
        timeoutMs: APPLY_TIMEOUT_MS,
        maxOutputBytes: APPLY_STDOUT_CAP,
      });
      const out = parsePatchApplyOutput(res.stdout);
      const audit = (after: Record<string, unknown>) =>
        writeAudit({
          ctx,
          category: "security",
          action: "server.patch_apply",
          entity: "server",
          entityId: String(serverId),
          before: before
            ? { upgradableCount: before.upgradableCount, securityCount: before.securityCount }
            : null,
          after: { mode, packageManager: out.packageManager, command: out.command, ...after },
        });

      if (out.started && (res.timedOut || res.cancelled)) {
        // It ran and may have changed packages before it was stopped.
        await audit({ ok: false, exitCode: null, timedOut: res.timedOut, durationMs: res.durationMs });
      }
      throwIfRemoteFailure(res, conn, "Could not apply updates");
      if (out.fatal) throw new PatchHostError(out.fatal);
      if (out.refused === "NO_UNATTENDED_UPGRADE") {
        throw new AppError(
          "CONFLICT",
          `Security-only updates on ${server.hostname} need unattended-upgrades, which is not installed. ` +
            `Install it (e.g. enable Auto-Updates for this server) or apply all updates instead.`,
          409,
        );
      }
      if (out.refused === "UNSUPPORTED") {
        throw new AppError(
          "CONFLICT",
          `No supported package manager (apt, dnf, yum or zypper) was found on ${server.hostname}`,
          409,
        );
      }
      if (!out.started) throw new PatchHostError("Incomplete output from the host while applying updates");

      const pm = out.packageManager ?? "unknown";
      const ok = out.complete && applySucceeded(pm, out.exitCode);
      let status: ServerPatchStatusDto | null = null;
      let rescanError: string | null = null;
      try {
        status = await scanOn(conn, server, false);
      } catch (err) {
        rescanError = clip(failureMessage(err), MAX_ERROR);
      }
      // A run that failed (apt's exit 100 on a held dpkg lock, output cut short, …)
      // may have installed nothing: rescan and audit it, but never report the
      // host as patched.
      if (ok) {
        const appliedAt = new Date();
        await prisma.serverPatchStatus.updateMany({ where: { serverId }, data: { lastAppliedAt: appliedAt } });
        if (status) status = { ...status, lastAppliedAt: appliedAt.toISOString() };
      }

      await audit({
        ok,
        exitCode: out.exitCode,
        durationMs: res.durationMs,
        ...(status
          ? {
              upgradableCount: status.upgradableCount,
              securityCount: status.securityCount,
              rebootRequired: status.rebootRequired,
            }
          : { rescanError }),
      });

      let output = out.output;
      if (!out.complete && !output) output = res.stdout.slice(-4000);
      return {
        ok,
        mode,
        packageManager: pm,
        command: out.command ?? patchApplyCommand(pm, mode) ?? "",
        exitCode: out.exitCode,
        output,
        outputTruncated: out.outputTruncated,
        durationMs: res.durationMs,
        status,
        rescanError,
      };
    } finally {
      conn.client.end();
    }
  } finally {
    appliesInFlight.delete(serverId);
  }
}

// ---------------------------------------------------------------------------
// Fleet report
// ---------------------------------------------------------------------------

const rowSelect = {
  serverId: true,
  packageManager: true,
  upgradableCount: true,
  securityCount: true,
  rebootRequired: true,
  kernelRunning: true,
  kernelLatest: true,
  osPretty: true,
  status: true,
  error: true,
  scannedAt: true,
  lastAppliedAt: true,
} as const;

/**
 * Every non-deleted server with its patch row (null when never scanned).
 * Filtered in the database; sorted in memory so never-scanned servers always
 * sort last (Postgres puts the NULLs of a LEFT JOIN first on DESC).
 */
export async function listPatchFleet(query: PatchListQuery): Promise<PatchListResponse> {
  const { q, securityOnly, rebootRequired, status, sortBy, sortDir } = query;
  const limit = query.limit ?? 50;
  const and: Prisma.ServerWhereInput[] = [{ deletedAt: null }];
  if (q) {
    and.push({
      OR: [
        { hostname: { contains: q, mode: "insensitive" } },
        { ip: { contains: q } },
        { environment: { contains: q, mode: "insensitive" } },
        { location: { name: { contains: q, mode: "insensitive" } } },
        { patchStatus: { is: { osPretty: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  if (status === "never") and.push({ patchStatus: { is: null } });
  else if (status) and.push({ patchStatus: { is: { status } } });
  if (securityOnly) and.push({ patchStatus: { is: { securityCount: { gt: 0 } } } });
  if (rebootRequired) and.push({ patchStatus: { is: { rebootRequired: true } } });

  const servers = await prisma.server.findMany({
    where: { AND: and },
    select: {
      id: true,
      hostname: true,
      ip: true,
      environment: true,
      lastStatus: true,
      location: { select: { id: true, name: true } },
      patchStatus: { select: rowSelect },
    },
  });

  const key = sortBy ?? "securityCount";
  const descByDefault = ["securityCount", "upgradableCount", "rebootRequired", "scannedAt"].includes(key);
  const dir = (sortDir ?? (descByDefault ? "desc" : "asc")) === "asc" ? 1 : -1;
  const value = (s: (typeof servers)[number]): string | number | null => {
    const p = s.patchStatus;
    switch (key) {
      case "hostname":
        return s.hostname.toLowerCase();
      case "environment":
        return s.environment?.toLowerCase() ?? null;
      case "securityCount":
        return p ? p.securityCount : null;
      case "upgradableCount":
        return p ? p.upgradableCount : null;
      case "rebootRequired":
        return p ? Number(p.rebootRequired) : null;
      case "status":
        return p ? p.status : null;
      case "packageManager":
        return p?.packageManager ?? null;
      case "scannedAt":
        return p ? p.scannedAt.getTime() : null;
    }
  };
  const sorted = servers
    .map((s) => ({ s, v: value(s) }))
    .sort((a, b) => {
      if (a.v === null && b.v !== null) return 1;
      if (b.v === null && a.v !== null) return -1;
      if (a.v !== null && b.v !== null && a.v !== b.v) return (a.v < b.v ? -1 : 1) * dir;
      // Tie-breakers: more pending updates first, then by hostname.
      const ua = a.s.patchStatus?.upgradableCount ?? -1;
      const ub = b.s.patchStatus?.upgradableCount ?? -1;
      if (key === "securityCount" && ua !== ub) return ub - ua;
      return a.s.hostname.localeCompare(b.s.hostname) || a.s.id - b.s.id;
    })
    .map((x) => x.s);

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = query.page && query.page > 0 ? query.page : 1;
  const items: PatchFleetRow[] = sorted.slice((page - 1) * limit, page * limit).map((s) => ({
    serverId: s.id,
    hostname: s.hostname,
    ip: s.ip,
    environment: s.environment,
    location: s.location,
    lastStatus: s.lastStatus,
    patch: s.patchStatus ? toSummaryDto(s.patchStatus) : null,
  }));
  return { items, nextCursor: null, total, page, totalPages };
}

export async function getPatchSummary(): Promise<PatchSummary> {
  const [totalServers, rows] = await Promise.all([
    prisma.server.count({ where: { deletedAt: null } }),
    prisma.serverPatchStatus.findMany({
      where: { server: { deletedAt: null } },
      select: { upgradableCount: true, securityCount: true, rebootRequired: true, status: true, scannedAt: true },
    }),
  ]);
  let lastScannedAt: Date | null = null;
  const summary: PatchSummary = {
    totalServers,
    scanned: rows.length,
    neverScanned: Math.max(0, totalServers - rows.length),
    withSecurityUpdates: 0,
    withUpdates: 0,
    totalUpdates: 0,
    totalSecurityUpdates: 0,
    rebootRequired: 0,
    errors: 0,
    unsupported: 0,
    lastScannedAt: null,
    scanning: patchScansInProgress(),
  };
  for (const r of rows) {
    if (r.securityCount > 0) summary.withSecurityUpdates++;
    if (r.upgradableCount > 0) summary.withUpdates++;
    summary.totalUpdates += r.upgradableCount;
    summary.totalSecurityUpdates += r.securityCount;
    if (r.rebootRequired) summary.rebootRequired++;
    if (r.status === "error") summary.errors++;
    if (r.status === "unsupported") summary.unsupported++;
    if (!lastScannedAt || r.scannedAt > lastScannedAt) lastScannedAt = r.scannedAt;
  }
  summary.lastScannedAt = lastScannedAt ? lastScannedAt.toISOString() : null;
  return summary;
}

// ---------------------------------------------------------------------------
// HTTP mapping
// ---------------------------------------------------------------------------

export function patchErrorToHttp(err: unknown): { status: 404 | 409 | 502 | 503 | 504; code: string; message: string } {
  if (err instanceof SshError) {
    const { status, message, code } = sshErrorToHttp(err);
    return { status, code: code ?? (status === 404 ? "NOT_FOUND" : "SSH_ERROR"), message };
  }
  if (err instanceof RemoteFailureError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof PatchHostError) return { status: 502, code: "PATCH_HOST_ERROR", message: err.message };
  const message = (err as { message?: string } | null)?.message || "Patch operation failed";
  return { status: 502, code: "PATCH_HOST_ERROR", message };
}
