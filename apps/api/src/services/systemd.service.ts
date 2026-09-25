import {
  isValidSystemdUnitName,
  journalSinceArg,
  SYSTEMD_ACTIONS,
  SYSTEMD_LOG_LINES_MAX,
  SYSTEMD_UNIT_TYPES,
  systemdActionNeedsSudo,
  type SystemdAction,
  type SystemdActionResponse,
  type SystemdListType,
  type SystemdLogsResponse,
  type SystemdUnitDetails,
  type SystemdUnitDto,
  type SystemdUnitListResponse,
} from "@inv/shared";
import type { AuditCtx } from "../lib/audit.js";
import { writeAudit } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { connectToServer, SshError, sshErrorToHttp } from "./ssh.service.js";
import {
  describeRemoteFailure,
  execAsRoot,
  execPreferRoot,
  RemoteFailureError,
  remoteFailureToHttp,
  type RemoteScriptResult,
} from "./remote-exec.service.js";
import { escapeShellArg } from "./shell-escape.js";

/**
 * systemd service manager: list units, show one unit, read its journal, and run
 * start/stop/restart/reload/enable/disable on it.
 *
 * Every host interaction is one script run through remote-exec (uploaded over
 * stdin, never in argv): reads with execPreferRoot, actions with execAsRoot.
 * Script output is a sequence of `===KIND===` header lines, each optionally
 * followed by ONE base64 payload line, so host output can never be mistaken for
 * a marker. The unit name is re-validated here before it is interpolated, and
 * then only ever appears as `U=<escapeShellArg(unit)>`; the rest of the script
 * refers to "$U".
 */

export interface SystemdConnOptions {
  overridePassword?: string;
  /** The caller holds server:sudo (required for protected units, see systemdActionNeedsSudo). */
  canSudo?: boolean;
}

const READ_TIMEOUT_MS = 60_000;
/** systemctl blocks until the job finishes; systemd's default start/stop timeout is 90 s. */
const ACTION_TIMEOUT_MS = 150_000;
const LIST_OUTPUT_CAP = 16 * 1024 * 1024;
const LOG_OUTPUT_CAP = 8 * 1024 * 1024;
/** Per section, on the host (before base64). */
const LIST_SECTION_BYTES = 4 * 1024 * 1024;
const LOG_SECTION_BYTES = 4 * 1024 * 1024;
const DETAIL_JOURNAL_LINES = 20;
const MAX_UNITS = 5000;
const ACTION_OUTPUT_CHARS = 4000;

const SHOW_PROPERTIES = [
  "Id",
  "Description",
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "MainPID",
  "ExecMainStartTimestamp",
  "MemoryCurrent",
  "FragmentPath",
  "Restart",
  "NRestarts",
].join(",");
const STATE_PROPERTIES = "Id,LoadState,ActiveState,SubState,UnitFileState";
const RESOLVE_PROPERTIES = "Id,Names,LoadState";

const LIST_TYPES: Record<SystemdListType, readonly string[]> = {
  service: ["service"],
  timer: ["timer"],
  socket: ["socket"],
  all: SYSTEMD_UNIT_TYPES,
};

const ACTION_VERBS: Record<SystemdAction, string> = {
  start: "Starting",
  stop: "Stopping",
  restart: "Restarting",
  reload: "Reloading",
  enable: "Enabling",
  disable: "Disabling",
};

export class SystemdHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemdHostError";
  }
}

// ---------------------------------------------------------------------------
// Validation at the point of interpolation (the routes validated too)
// ---------------------------------------------------------------------------

export function checkedUnit(unit: unknown): string {
  if (typeof unit !== "string" || !isValidSystemdUnitName(unit)) {
    throw new AppError("VALIDATION_ERROR", "Invalid systemd unit name", 400);
  }
  return unit;
}

function checkedAction(action: unknown): SystemdAction {
  if (typeof action !== "string" || !(SYSTEMD_ACTIONS as readonly string[]).includes(action)) {
    throw new AppError("VALIDATION_ERROR", "Invalid systemd action", 400);
  }
  return action as SystemdAction;
}

function checkedListType(type: unknown): SystemdListType {
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(LIST_TYPES, type)) {
    throw new AppError("VALIDATION_ERROR", "Invalid unit type filter", 400);
  }
  return type as SystemdListType;
}

function checkedLines(lines: unknown): number {
  if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > SYSTEMD_LOG_LINES_MAX) {
    throw new AppError("VALIDATION_ERROR", `lines must be an integer between 1 and ${SYSTEMD_LOG_LINES_MAX}`, 400);
  }
  return lines;
}

/**
 * The protected-unit rule, by name. Throws 403 when `action` on `unit` needs
 * server:sudo and the caller lacks it. The action path re-applies it to every
 * name the host reports for the unit (aliases), see runSystemdAction.
 */
export function assertSystemdActionAllowed(unit: string, action: SystemdAction, canSudo: boolean | undefined): void {
  if (canSudo) return;
  if (systemdActionNeedsSudo(unit, action)) {
    throw new AppError(
      "FORBIDDEN",
      `${ACTION_VERBS[action]} ${unit} requires the server:sudo permission (protected unit)`,
      403,
    );
  }
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const PRELUDE = `set +e
exec </dev/null
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
SYSTEMD_PAGER=cat
SYSTEMD_COLORS=0
export SYSTEMD_PAGER SYSTEMD_COLORS
command -v base64 >/dev/null 2>&1 || { echo '===FATAL:NO_BASE64==='; exit 3; }
b64() { base64 | tr -d '\\n'; echo; }
emit() { printf '===%s===\\n' "$1"; }
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then emit NOSYSTEMD; emit END; exit 0; fi
`;

function unitAssignment(unit: string): string {
  return `U=${escapeShellArg(checkedUnit(unit))}`;
}

/** list-units (loaded units) + list-unit-files (enablement, and units systemd has not loaded). */
export function buildSystemdListScript(type: SystemdListType): string {
  const types = LIST_TYPES[checkedListType(type)].join(",");
  return `${PRELUDE}T=${escapeShellArg(types)}
emit UNITS; systemctl list-units --all --no-pager --plain --no-legend --full --type="$T" 2>/dev/null | head -c ${LIST_SECTION_BYTES} | b64
emit FILES; systemctl list-unit-files --no-pager --no-legend --full --type="$T" 2>/dev/null | head -c ${LIST_SECTION_BYTES} | b64
emit END
`;
}

export function buildSystemdShowScript(unit: string): string {
  return `${PRELUDE}${unitAssignment(unit)}
emit SHOW; systemctl show --no-pager -p ${SHOW_PROPERTIES} -- "$U" 2>&1 | head -c 65536 | b64
emit JOURNAL; journalctl --unit="$U" -n ${DETAIL_JOURNAL_LINES} --no-pager -o short-iso 2>&1 | head -c 262144 | b64
emit END
`;
}

export function buildSystemdLogsScript(unit: string, lines: number, since?: string): string {
  const assign = unitAssignment(unit);
  const n = checkedLines(lines);
  let sinceArg = "";
  if (since !== undefined) {
    const arg = journalSinceArg(since);
    if (arg === null) throw new AppError("VALIDATION_ERROR", 'Invalid "since"', 400);
    sinceArg = ` --since=${escapeShellArg(arg)}`;
  }
  return `${PRELUDE}${assign}
emit LOGS; journalctl --unit="$U" -n ${escapeShellArg(String(n))} --no-pager -o short-iso${sinceArg} 2>&1 | head -c ${LOG_SECTION_BYTES} | b64
emit END
`;
}

/** Every name the host knows the unit by (Id + Names), for the alias half of the protected rule. */
export function buildSystemdResolveScript(unit: string): string {
  return `${PRELUDE}${unitAssignment(unit)}
emit SHOW; systemctl show --no-pager -p ${RESOLVE_PROPERTIES} -- "$U" 2>&1 | head -c 65536 | b64
emit END
`;
}

/**
 * State before, the action (output captured, exit status recorded), state after.
 * `--no-ask-password` so a polkit prompt can never block the run.
 */
export function buildSystemdActionScript(unit: string, action: SystemdAction): string {
  const assign = unitAssignment(unit);
  const a = checkedAction(action);
  return `${PRELUDE}${assign}
A=${escapeShellArg(a)}
emit BEFORE; systemctl show --no-pager -p ${STATE_PROPERTIES} -- "$U" 2>/dev/null | b64
out=$(systemctl --no-ask-password "$A" -- "$U" 2>&1); rc=$?
emit RC; printf '%s' "$rc" | b64
emit OUT; printf '%s' "$out" | head -c 16384 | b64
emit AFTER; systemctl show --no-pager -p ${STATE_PROPERTIES} -- "$U" 2>/dev/null | b64
emit END
`;
}

// ---------------------------------------------------------------------------
// Output parsing (exported for tests)
// ---------------------------------------------------------------------------

interface Block {
  kind: string;
  name: string;
  payload: string;
}

const HEADER_PATTERN = /^===([A-Z]+)(?::([^=\n]*))?===$/;
const B64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function parseSystemdBlocks(stdout: string): Block[] {
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

function decodeText(payload: string): string {
  if (!B64_PATTERN.test(payload)) return "";
  return Buffer.from(payload, "base64").toString("utf8");
}

function blockText(blocks: Block[], kind: string): string | undefined {
  const b = blocks.find((x) => x.kind === kind);
  return b ? decodeText(b.payload) : undefined;
}

interface CheckedBlocks {
  blocks: Block[];
  /** The host does not run systemd. */
  unsupported: boolean;
}

function checkBlocks(stdout: string, what: string): CheckedBlocks {
  const blocks = parseSystemdBlocks(stdout);
  const fatal = blocks.find((b) => b.kind === "FATAL");
  if (fatal) {
    throw new SystemdHostError(
      fatal.name === "NO_BASE64"
        ? "The host has no base64 command (coreutils/busybox), which the service manager needs"
        : `systemd script failed on the host (${fatal.name})`,
    );
  }
  if (!blocks.some((b) => b.kind === "END")) throw new SystemdHostError(`Incomplete output from the host while ${what}`);
  return { blocks, unsupported: blocks.some((b) => b.kind === "NOSYSTEMD") };
}

function notSystemd(): AppError {
  return new AppError("CONFLICT", "systemd is not running on this host", 409);
}

/** "UNIT LOAD ACTIVE SUB DESCRIPTION" rows; the description keeps its inner spacing. */
const LIST_UNITS_ROW = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*?))?\s*$/;
/** "UNIT FILE STATE [VENDOR PRESET]" rows (the preset column only exists in newer systemd). */
const LIST_FILES_ROW = /^(\S+)\s+([a-z][a-z-]*)(?:\s+\S+)?\s*$/;
/** Anything systemd would call a unit: a name, a dot, a lowercase type. */
const UNIT_TOKEN = /^\S+\.[a-z]+$/;

export interface ListedUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

/** `systemctl list-units --all --plain --no-legend` → rows. Tolerates a leading "●"/"*" and a legend. */
export function parseListUnits(text: string): ListedUnit[] {
  const out: ListedUnit[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(/^\s*(?:●|\*)?\s*/, "");
    if (!line) continue;
    const m = LIST_UNITS_ROW.exec(line);
    if (!m || !UNIT_TOKEN.test(m[1]!)) continue;
    out.push({ unit: m[1]!, load: m[2]!, active: m[3]!, sub: m[4]!, description: m[5] ?? "" });
  }
  return out;
}

/** `systemctl list-unit-files --no-legend` → unit → state. */
export function parseListUnitFiles(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    const m = LIST_FILES_ROW.exec(line);
    if (!m || !UNIT_TOKEN.test(m[1]!)) continue;
    out.set(m[1]!, m[2]!);
  }
  return out;
}

function unitType(unit: string): string {
  return unit.slice(unit.lastIndexOf(".") + 1);
}

/** "getty@tty1.service" → "getty@.service"; null for a unit that is not a template instance. */
function templateOf(unit: string): string | null {
  const m = /^([^@]+)@[^@]+\.([a-z]+)$/.exec(unit);
  return m ? `${m[1]}@.${m[2]}` : null;
}

/**
 * Loaded units, with enablement from the unit files, plus every installed unit
 * file systemd has not loaded (so a disabled, never-started service is still
 * listed and can be started). Templates ("foo@.service") are left out — only
 * their instances can be acted on.
 */
export function mergeSystemdUnits(units: ListedUnit[], files: Map<string, string>, types: readonly string[]): SystemdUnitDto[] {
  const byName = new Map<string, SystemdUnitDto>();
  for (const u of units) {
    if (!types.includes(unitType(u.unit)) || byName.has(u.unit)) continue;
    const tpl = templateOf(u.unit);
    byName.set(u.unit, {
      ...u,
      enabled: files.get(u.unit) ?? (tpl ? files.get(tpl) : undefined) ?? null,
    });
  }
  for (const [unit, state] of files) {
    // "alias" rows (sshd.service → ssh.service) would list the same unit twice.
    if (byName.has(unit) || unit.includes("@.") || state === "alias" || !types.includes(unitType(unit))) continue;
    byName.set(unit, { unit, load: "not-loaded", active: "inactive", sub: "dead", description: "", enabled: state });
  }
  return [...byName.values()].sort((a, b) => a.unit.localeCompare(b.unit));
}

export function parseSystemdListOutput(stdout: string, type: SystemdListType): { supported: boolean; units: SystemdUnitDto[]; truncated: boolean } {
  const { blocks, unsupported } = checkBlocks(stdout, "listing units");
  if (unsupported) return { supported: false, units: [], truncated: false };
  const unitsText = blockText(blocks, "UNITS") ?? "";
  const filesText = blockText(blocks, "FILES") ?? "";
  const merged = mergeSystemdUnits(parseListUnits(unitsText), parseListUnitFiles(filesText), LIST_TYPES[type]);
  const truncated =
    merged.length > MAX_UNITS ||
    Buffer.byteLength(unitsText, "utf8") >= LIST_SECTION_BYTES ||
    Buffer.byteLength(filesText, "utf8") >= LIST_SECTION_BYTES;
  return { supported: true, units: merged.slice(0, MAX_UNITS), truncated };
}

/** `systemctl show -p …` → key → value (split at the first "="). */
export function parseShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}

const UINT64_MAX = "18446744073709551615";

function optString(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" || t === "n/a" || t === "[not set]" ? null : t;
}

function optCount(v: string | undefined): number | null {
  const t = v?.trim();
  if (!t || !/^\d{1,19}$/.test(t) || t === UINT64_MAX) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function toUnitDetails(unit: string, show: Record<string, string>, journal: string, ranAsRoot: boolean): SystemdUnitDetails {
  const pid = optCount(show["MainPID"]);
  return {
    unit,
    id: optString(show["Id"]) ?? unit,
    description: show["Description"]?.trim() ?? "",
    loadState: optString(show["LoadState"]) ?? "unknown",
    activeState: optString(show["ActiveState"]) ?? "unknown",
    subState: optString(show["SubState"]) ?? "unknown",
    unitFileState: optString(show["UnitFileState"]),
    mainPid: pid === 0 ? null : pid,
    startedAt: optString(show["ExecMainStartTimestamp"]),
    memoryBytes: optCount(show["MemoryCurrent"]),
    fragmentPath: optString(show["FragmentPath"]),
    restart: optString(show["Restart"]),
    nRestarts: optCount(show["NRestarts"]),
    journal: splitLines(journal),
    ranAsRoot,
  };
}

/** What happened to the unit, as recorded in the server.systemd_action audit row. */
export type SystemdActionOutcome = "succeeded" | "failed" | "unknown";

export interface SystemdActionRun {
  /** The prelude exited (no base64, no systemd) before systemctl could run. */
  skipped: boolean;
  exitCode: number | null;
  output: string;
  before: Record<string, string>;
  after: Record<string, string>;
}

/**
 * The action script's output, read from whole lines only, so a run that was cut
 * short (timeout, dropped channel) still yields what it got to: the state
 * before and, once systemctl returned, its exit status. The host cannot forge a
 * header (everything it prints is base64), so FATAL/NOSYSTEMD really are the
 * prelude bailing out.
 */
export function readSystemdActionOutput(stdout: string): SystemdActionRun {
  const blocks = parseSystemdBlocks(stdout.slice(0, stdout.lastIndexOf("\n") + 1));
  const rcText = (blockText(blocks, "RC") ?? "").trim();
  return {
    skipped: blocks.some((b) => b.kind === "FATAL" || b.kind === "NOSYSTEMD"),
    exitCode: /^\d{1,3}$/.test(rcText) ? Number(rcText) : null,
    output: (blockText(blocks, "OUT") ?? "").trim().slice(0, ACTION_OUTPUT_CHARS),
    before: parseShow(blockText(blocks, "BEFORE") ?? ""),
    after: parseShow(blockText(blocks, "AFTER") ?? ""),
  };
}

/** No exit status and no early bail-out: systemctl may or may not have acted. */
export function systemdActionOutcome(run: SystemdActionRun): SystemdActionOutcome {
  if (run.exitCode === 0) return "succeeded";
  if (run.exitCode !== null || run.skipped) return "failed";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Conn = Awaited<ReturnType<typeof connectToServer>>;

async function withHost<T>(serverId: number, opts: SystemdConnOptions, fn: (conn: Conn) => Promise<T>): Promise<T> {
  const conn = opts.overridePassword ? await connectToServer(serverId, opts.overridePassword) : await connectToServer(serverId);
  try {
    return await fn(conn);
  } finally {
    conn.client.end();
  }
}

type ScriptResult = RemoteScriptResult & { ranAsRoot: boolean };
type ScriptOptions = { timeoutMs: number; maxOutputBytes: number };

async function execScript(conn: Conn, script: string, mode: "read" | "root", o: ScriptOptions): Promise<ScriptResult> {
  return mode === "read"
    ? await execPreferRoot(conn.client, script, conn.password, o)
    : { ...(await execAsRoot(conn.client, script, conn.password, o)), ranAsRoot: true };
}

/** Transport and sudo failures become RemoteFailureError (the route maps it). */
function assertScriptRan(conn: Conn, res: RemoteScriptResult): void {
  const failure = remoteFailureToHttp(res, conn.passwordUnavailable ? { passwordUnavailable: conn.passwordUnavailable } : {});
  if (failure) throw new RemoteFailureError(failure);
  if (res.errorCode) throw new SystemdHostError(describeRemoteFailure(res));
}

/** Run a script; throws on any failure around it (see assertScriptRan). */
async function runScript(conn: Conn, script: string, mode: "read" | "root", o: ScriptOptions): Promise<ScriptResult> {
  const res = await execScript(conn, script, mode, o);
  assertScriptRan(conn, res);
  return res;
}

/**
 * The run channel opened, so the script may have acted on the host. Every other
 * remote-exec error (UPLOAD_FAILED, NO_INTERPRETER, SUDO_*) is reported before
 * that. CANCELLED counts as started because it can also come mid-run.
 */
export function remoteScriptStarted(res: RemoteScriptResult): boolean {
  return res.errorCode === undefined || res.errorCode === "TIMEOUT" || res.errorCode === "CANCELLED";
}

/** GET /servers/:id/systemd/units */
export async function listSystemdUnits(
  serverId: number,
  query: { type: SystemdListType; q?: string },
  opts: SystemdConnOptions = {},
): Promise<SystemdUnitListResponse> {
  const type = checkedListType(query.type);
  const script = buildSystemdListScript(type);
  return withHost(serverId, opts, async (conn) => {
    const res = await runScript(conn, script, "read", { timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: LIST_OUTPUT_CAP });
    if (res.stdoutTruncated) throw new SystemdHostError("The host's unit list is too large to load");
    const parsed = parseSystemdListOutput(res.stdout, type);
    if (!parsed.supported) return { supported: false, units: [] };
    const q = query.q?.trim().toLowerCase();
    const units = q
      ? parsed.units.filter((u) => u.unit.toLowerCase().includes(q) || u.description.toLowerCase().includes(q))
      : parsed.units;
    const out: SystemdUnitListResponse = { supported: true, units, ranAsRoot: res.ranAsRoot };
    if (parsed.truncated) out.truncated = true;
    return out;
  });
}

/** GET /servers/:id/systemd/units/:unit — properties plus the last 20 journal lines. */
export async function getSystemdUnit(serverId: number, unitName: string, opts: SystemdConnOptions = {}): Promise<SystemdUnitDetails> {
  const unit = checkedUnit(unitName);
  const script = buildSystemdShowScript(unit);
  return withHost(serverId, opts, async (conn) => {
    const res = await runScript(conn, script, "read", { timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: LOG_OUTPUT_CAP });
    const { blocks, unsupported } = checkBlocks(res.stdout, "reading the unit");
    if (unsupported) throw notSystemd();
    const show = parseShow(blockText(blocks, "SHOW") ?? "");
    // A unit whose file is gone but that is still running/failed has details worth showing.
    if (show["LoadState"] === "not-found" && (show["ActiveState"] ?? "inactive") === "inactive") {
      throw new AppError("NOT_FOUND", `Unit ${unit} was not found on this host`, 404);
    }
    return toUnitDetails(unit, show, blockText(blocks, "JOURNAL") ?? "", res.ranAsRoot);
  });
}

/** GET /servers/:id/systemd/units/:unit/logs */
export async function getSystemdUnitLogs(
  serverId: number,
  unitName: string,
  query: { lines: number; since?: string },
  opts: SystemdConnOptions = {},
): Promise<SystemdLogsResponse> {
  const unit = checkedUnit(unitName);
  const script = buildSystemdLogsScript(unit, query.lines, query.since);
  return withHost(serverId, opts, async (conn) => {
    const res = await runScript(conn, script, "read", { timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: LOG_OUTPUT_CAP });
    const { blocks, unsupported } = checkBlocks(res.stdout, "reading the journal");
    if (unsupported) throw notSystemd();
    const text = blockText(blocks, "LOGS") ?? "";
    return {
      unit,
      lines: splitLines(text),
      truncated: res.stdoutTruncated || Buffer.byteLength(text, "utf8") >= LOG_SECTION_BYTES,
      ranAsRoot: res.ranAsRoot,
    };
  });
}

/** Names from `systemctl show -p Id,Names` that the protected rule applies to. */
export function hostUnitNames(show: Record<string, string>): string[] {
  const names = new Set<string>();
  const id = show["Id"]?.trim();
  if (id) names.add(id);
  for (const n of (show["Names"] ?? "").split(/\s+/)) if (n) names.add(n);
  return [...names].filter(isValidSystemdUnitName);
}

/**
 * POST /servers/:id/systemd/units/:unit/action. Without server:sudo the rule is
 * applied to the requested name first (no SSH), then to every name the host
 * reports for the unit, so an alias such as dbus-org.freedesktop.resolve1.service
 * cannot be used to stop systemd-resolved.
 *
 * The server.systemd_action row is written whenever the action script started,
 * with its outcome, including a run that failed or timed out afterwards (the
 * error is still thrown). Refusals and failures before that write no row.
 */
export async function runSystemdAction(
  serverId: number,
  unitName: string,
  actionName: SystemdAction,
  ctx: AuditCtx,
  opts: SystemdConnOptions = {},
): Promise<SystemdActionResponse> {
  const unit = checkedUnit(unitName);
  const action = checkedAction(actionName);
  assertSystemdActionAllowed(unit, action, opts.canSudo);
  const script = buildSystemdActionScript(unit, action);

  return withHost(serverId, opts, async (conn) => {
    if (!opts.canSudo) {
      const resolved = await runScript(conn, buildSystemdResolveScript(unit), "root", {
        timeoutMs: READ_TIMEOUT_MS,
        maxOutputBytes: 256 * 1024,
      });
      const { blocks, unsupported } = checkBlocks(resolved.stdout, "resolving the unit");
      if (unsupported) throw notSystemd();
      const show = parseShow(blockText(blocks, "SHOW") ?? "");
      for (const name of hostUnitNames(show)) {
        if (name !== unit && systemdActionNeedsSudo(name, action)) {
          throw new AppError(
            "FORBIDDEN",
            `${unit} is another name for ${show["Id"]?.trim() || name}; ${ACTION_VERBS[action].toLowerCase()} it requires the server:sudo permission (protected unit)`,
            403,
          );
        }
      }
    }

    const res = await execScript(conn, script, "root", { timeoutMs: ACTION_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
    const run = readSystemdActionOutput(res.stdout);
    const ok = run.exitCode === 0;
    const audit = (extra: Record<string, unknown> = {}) =>
      writeAudit({
        ctx,
        category: "security",
        action: "server.systemd_action",
        entity: "server",
        entityId: String(serverId),
        before: {
          unit,
          activeState: optString(run.before["ActiveState"]),
          subState: optString(run.before["SubState"]),
          unitFileState: optString(run.before["UnitFileState"]),
        },
        after: {
          unit,
          action,
          outcome: systemdActionOutcome(run),
          ok,
          exitCode: run.exitCode,
          activeState: optString(run.after["ActiveState"]),
          subState: optString(run.after["SubState"]),
          unitFileState: optString(run.after["UnitFileState"]),
          ...(ok ? {} : { output: run.output.slice(0, 500) }),
          ...extra,
        },
      });

    try {
      assertScriptRan(conn, res);
      if (checkBlocks(res.stdout, `running systemctl ${action}`).unsupported) throw notSystemd();
    } catch (err) {
      // Once started it may have acted before it timed out, lost its channel or was cut short.
      if (remoteScriptStarted(res)) {
        await audit({
          errorCode: res.errorCode ?? (err instanceof AppError ? err.code : systemdErrorToHttp(err).code),
          error: ((err as { message?: string } | null)?.message ?? "").slice(0, 500),
        });
      }
      throw err;
    }

    await audit();
    return {
      unit,
      action,
      ok,
      exitCode: run.exitCode,
      activeState: optString(run.after["ActiveState"]),
      subState: optString(run.after["SubState"]),
      unitFileState: optString(run.after["UnitFileState"]),
      stderr: run.output,
    };
  });
}

/** HTTP mapping for everything the service can throw except AppError (rethrow those). */
export function systemdErrorToHttp(err: unknown): { status: 404 | 409 | 502 | 503 | 504; code: string; message: string } {
  if (err instanceof SshError) {
    const { status, message, code } = sshErrorToHttp(err);
    return { status, code: code ?? (status === 404 ? "NOT_FOUND" : "SSH_ERROR"), message };
  }
  if (err instanceof RemoteFailureError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof SystemdHostError) return { status: 502, code: "SYSTEMD_HOST_ERROR", message: err.message };
  const message = (err as { message?: string } | null)?.message || "systemd operation failed";
  return { status: 502, code: "SYSTEMD_HOST_ERROR", message };
}
