/**
 * Wrap a crontab command so it reports to a RackMap heartbeat, and undo it.
 *
 * Pure string work on the COMMAND FIELD only — the schedule (and, in system
 * crontabs, the user) are handled by the caller through the cron parser. The
 * wrapped form is:
 *
 *   "${SHELL:-/bin/sh}" -c '<cmdPart>'; rc=$?; u="<BASE>/api/v1/ping/<TOKEN>/$rc"; (curl … "$u" || wget … "$u") >/dev/null 2>&1; exit $rc<stdinPart>
 *
 * Why this shape:
 *  - `"${SHELL:-/bin/sh}" -c`, not `sh -c`: cron exports SHELL from the crontab, so
 *    bash-isms in the original command keep working.
 *  - Single-quoting the original neutralises a trailing `&` (a bare `&;` is a syntax
 *    error), inline `# comments` (which would otherwise comment out the ping) and
 *    pipelines, and the inner shell re-parses exactly the text the outer one saw.
 *  - cron turns the first unescaped `%` into the end of the command and feeds the
 *    rest to stdin, so the original is split there: only `cmdPart` goes inside the
 *    quotes and `stdinPart` stays at the very end. The wrapper itself contains no `%`.
 *  - curl, then wget (BusyBox-compatible flags: no `-t`, no `--retry-connrefused`).
 *    A missing curl prints "not found" into the discarded subshell and wget runs.
 *  - `exit $rc` keeps the job's own exit status for cron's mail and for anything
 *    watching the job.
 */

export const HEARTBEAT_PING_PATH = "/api/v1/ping";

/**
 * vixie/Debian cron's MAX_COMMAND is 1000; longer lines are refused or silently
 * truncated (which would cut the ping off). Leave a little headroom.
 */
export const HEARTBEAT_MAX_CRON_LINE = 990;

/** No `$`, quotes, backticks, backslashes or whitespace — the base ends up inside `"…"`. */
export const HEARTBEAT_PING_BASE_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const CURL = 'curl -fsS -m 10 --retry 3 -o /dev/null "$u"';
const WGET = 'wget -q -T 10 -O /dev/null "$u"';
const SEND = `(${CURL} || ${WGET}) >/dev/null 2>&1`;

export type HeartbeatWrapErrorCode = "INVALID_BASE" | "INVALID_TOKEN" | "INVALID_COMMAND" | "ALREADY_WRAPPED" | "LINE_TOO_LONG";

export class HeartbeatWrapError extends Error {
  readonly code: HeartbeatWrapErrorCode;
  constructor(code: HeartbeatWrapErrorCode, message: string) {
    super(message);
    this.name = "HeartbeatWrapError";
    this.code = code;
  }
}

export interface WrapHeartbeatInput {
  /** The crontab command field, verbatim (may include a `%` stdin part). */
  command: string;
  /** PUBLIC_BASE_URL, e.g. `https://rackmap.example.com` (trailing slashes are dropped). */
  pingBase: string;
  token: string;
  /** Send a `/start` ping before the command, so the run's duration is recorded. */
  measureDuration?: boolean;
  /**
   * Characters the rest of the line takes (schedule, user, separators). When given,
   * the whole line is checked against HEARTBEAT_MAX_CRON_LINE.
   */
  linePrefixLength?: number;
}

export interface UnwrappedHeartbeatCommand {
  /** The original command field, byte-for-byte. */
  command: string;
  pingBase: string;
  token: string;
  measureDuration: boolean;
}

/** Strip trailing slashes and validate a ping base URL. */
export function normalizePingBase(pingBase: string): string {
  const base = pingBase.trim().replace(/\/+$/, "");
  if (!HEARTBEAT_PING_BASE_PATTERN.test(base)) {
    throw new HeartbeatWrapError(
      "INVALID_BASE",
      "PUBLIC_BASE_URL must be a plain http(s) URL (host, optional port and path; no query, credentials or special characters)",
    );
  }
  return base;
}

/**
 * Split a command field at its first unescaped `%`. `stdinPart` keeps the `%`
 * itself (it is re-appended verbatim), and is "" when there is none.
 */
export function splitCronCommandRaw(command: string): { cmdPart: string; stdinPart: string } {
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\") {
      i++; // skip the escaped character (cron only treats `\%` specially, but a `\` never starts a split)
      continue;
    }
    if (ch === "%") return { cmdPart: command.slice(0, i), stdinPart: command.slice(i) };
  }
  return { cmdPart: command, stdinPart: "" };
}

function quoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sendLine(url: string): string {
  return `u="${url}"; ${SEND}`;
}

/** Wrap a crontab command so every run pings the heartbeat with its exit code. */
export function wrapCommandForHeartbeat(input: WrapHeartbeatInput): string {
  const base = normalizePingBase(input.pingBase);
  if (!TOKEN_PATTERN.test(input.token)) {
    throw new HeartbeatWrapError("INVALID_TOKEN", "Heartbeat token must be 43 base64url characters");
  }
  if (/[\r\n\0]/.test(input.command)) {
    throw new HeartbeatWrapError("INVALID_COMMAND", "A crontab command cannot contain line breaks or NUL bytes");
  }
  if (unwrapHeartbeatCommand(input.command)) {
    throw new HeartbeatWrapError("ALREADY_WRAPPED", "This command already reports to a heartbeat");
  }
  const { cmdPart, stdinPart } = splitCronCommandRaw(input.command);
  if (cmdPart.trim() === "") {
    throw new HeartbeatWrapError("INVALID_COMMAND", "The crontab entry has no command to monitor");
  }

  const url = `${base}${HEARTBEAT_PING_PATH}/${input.token}`;
  const start = input.measureDuration ? `${sendLine(`${url}/start`)}; ` : "";
  const wrapped = `${start}"\${SHELL:-/bin/sh}" -c ${quoteSingle(cmdPart)}; rc=$?; ${sendLine(`${url}/$rc`)}; exit $rc${stdinPart}`;

  const lineLength = (input.linePrefixLength ?? 0) + wrapped.length;
  if (lineLength > HEARTBEAT_MAX_CRON_LINE) {
    throw new HeartbeatWrapError(
      "LINE_TOO_LONG",
      `The monitored crontab line would be ${lineLength} characters; cron truncates lines longer than about ${HEARTBEAT_MAX_CRON_LINE}. ` +
        "Move the command into a script and schedule the script instead.",
    );
  }
  return wrapped;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEND_RE = escapeRegex(SEND);
const PING_PATH_RE = escapeRegex(HEARTBEAT_PING_PATH);
const BASE_RE = "(https?://[A-Za-z0-9.-]+(?::\\d+)?(?:/[A-Za-z0-9._~/-]*)?)";
const TOKEN_RE = "([A-Za-z0-9_-]{43})";

// Anchored on the exact format wrapCommandForHeartbeat produces; anything a human
// edited into a different shape is deliberately NOT recognised.
const WRAPPED_RE = new RegExp(
  "^" +
    `(?:u="${BASE_RE}${PING_PATH_RE}/${TOKEN_RE}/start"; ${SEND_RE}; )?` +
    `"\\$\\{SHELL:-/bin/sh\\}" -c '((?:[^']|'\\\\'')*)'; rc=\\$\\?; ` +
    `u="${BASE_RE}${PING_PATH_RE}/${TOKEN_RE}/\\$rc"; ${SEND_RE}; exit \\$rc` +
    "(%[\\s\\S]*)?$",
);

/** Inverse of wrapCommandForHeartbeat; null when `command` is not in the wrapped format. */
export function unwrapHeartbeatCommand(command: string): UnwrappedHeartbeatCommand | null {
  const m = WRAPPED_RE.exec(command);
  if (!m) return null;
  const [, startBase, startToken, quoted, base, token, stdinPart] = m;
  if (!quoted || !base || !token) return null;
  // A start ping for a different heartbeat means the line was hand-edited: not ours.
  if (startToken !== undefined && (startToken !== token || startBase !== base)) return null;
  return {
    command: quoted.replace(/'\\''/g, "'") + (stdinPart ?? ""),
    pingBase: base,
    token,
    measureDuration: startToken !== undefined,
  };
}
