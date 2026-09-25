import { StringDecoder } from "node:string_decoder";
import { currentSudoPasswordOverride } from "../lib/sudo-context.js";
import type { Client, ClientChannel } from "ssh2";
import { escapeShellArg } from "./shell-escape.js";
import { VAULT_LOCKED_MESSAGE } from "./ssh.service.js";

/**
 * The single way RackMap runs a script on a managed host.
 *
 * - The script travels over stdin into a mktemp file (channel 1), so it never
 *   appears in argv: it is invisible to `ps` / `/proc/<pid>/cmdline` on the host
 *   and not bounded by MAX_ARG_STRLEN. Secrets that belong to the script (a
 *   chpasswd line, runbook parameters) must therefore live INSIDE the script.
 * - sudo is probed with `sudo -n /bin/sh -c :` before any password is written.
 *   Only when that fails does the run use `sudo -k -S -p ''`, which always reads
 *   exactly one password line; the channel is then ended so nothing else can
 *   read stdin. Writing a password to a command that does not consume it would
 *   hand it to the first thing in the script that reads stdin (`crontab -`, `read`).
 * - The remote side is wrapped in `timeout -k 10`, because closing a channel that
 *   has no PTY sends no SIGHUP: the script would keep running. A local timeout or
 *   an AbortSignal additionally runs `pkill -f <tmpfile>` on a fresh channel.
 * - The run wrapper prints EXEC_STARTED_MARKER on stdout before anything else,
 *   i.e. only once sudo has let it start. It is stripped from the output, and a
 *   failure is attributed to RackMap's sudo only when it never appeared: after
 *   it, stderr belongs to the script, including any `sudo -n` of its own.
 * - stdout and stderr are always consumed. ssh2 (lib/utils.js onChannelClose)
 *   only emits 'close' after stdout has ended, and an unread stdout never ends —
 *   that is what made every OS-user write hang forever before this existed.
 *
 * Outcomes are reported, not thrown: every failure (including a channel that
 * could not be opened) resolves with `errorCode` set, so per-host callers such as
 * the runbook executor can map it without a try/catch. Invalid options throw.
 */

export type RemoteExecErrorCode =
  /** The script never started: a channel could not be opened or mktemp/cat failed. */
  | "UPLOAD_FAILED"
  | "NO_INTERPRETER"
  | "SUDO_PASSWORD_REQUIRED"
  | "SUDO_AUTH_FAILED"
  | "SUDO_REQUIRETTY"
  | "SUDO_NOT_ALLOWED"
  | "TIMEOUT"
  | "CANCELLED";

export interface RemoteScriptOptions {
  /** Full file content (any prelude + body). */
  script: string;
  /** Default "sh" (/bin/sh). "bash" is resolved with `command -v bash` on the host. */
  interpreter?: "sh" | "bash";
  /** Run through sudo as root (no sudo at all when the SSH user already is root). */
  asRoot?: boolean;
  /** SSH password from connectToServer(); only ever written to sudo's stdin, and only if `sudo -n` fails. */
  sudoPassword?: string;
  /** Remote-side timeout in whole seconds (1–86400, default 300). */
  timeoutSec?: number;
  /** Cap per stream in bytes (default 4 MiB); excess is dropped and the *Truncated flag set. */
  maxOutputBytes?: number;
  /** Decoded, NUL-free output as it arrives (only the part within the cap). */
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
  signal?: AbortSignal;
}

export interface RemoteScriptResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  errorCode?: RemoteExecErrorCode;
  /**
   * Operator-facing detail for `errorCode`, or a hint for a plain non-zero exit
   * (an unexplained SIGKILL). Never contains the script or a password.
   */
  errorMessage?: string;
  /** Signal name when the remote process was killed by a signal (e.g. "SIGTERM"). */
  exitSignal?: string;
}

export class RemoteExecError extends Error {
  constructor(
    public code: RemoteExecErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteExecError";
  }
}

// ---------------------------------------------------------------------------
// Remote command templates. Every value interpolated into them is either a
// constant, validated against a strict pattern, or passed through escapeShellArg.
// ---------------------------------------------------------------------------

const REMOTE_FILE_PREFIX = "/tmp/.rackmap-x.";
/** What mktemp must hand back; anything else is refused rather than interpolated. */
export const REMOTE_FILE_PATTERN = /^\/tmp\/\.rackmap-x\.[A-Za-z0-9]{10}$/;
const INTERPRETER_PATH_PATTERN = /^\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;

/** Channel 1: stage the script. umask 077 → the file is 0600, owned by the SSH user. */
export const UPLOAD_COMMAND = `umask 077; f=$(mktemp /tmp/.rackmap-x.XXXXXXXXXX) && cat >"$f" && printf '%s\\n' "$f"`;

/** Seconds `timeout` waits after TERM before it sends KILL. */
const REMOTE_KILL_GRACE_SEC = 10;

/**
 * First bytes of the run channel's stdout once the wrapper is running (so sudo,
 * when used, has succeeded). No trailing newline, so a PTY's CRLF translation
 * cannot change it. Stripped before any output is collected or streamed.
 */
export const EXEC_STARTED_MARKER = "RACKMAP_EXEC_STARTED";

/**
 * Prints the start marker, then runs `$3` with interpreter `$2` under
 * `timeout $1` when a working `timeout` exists. The `timeout -k 1 5 true` check
 * matters: old BusyBox builds ship a `timeout` without `-k` (and with a
 * different syntax), which would otherwise fail before the script ever ran.
 */
const RUN_WRAPPER =
  `printf %s ${EXEC_STARTED_MARKER}; ` +
  `if command -v timeout >/dev/null 2>&1 && timeout -k 1 5 true >/dev/null 2>&1; ` +
  `then exec timeout -k ${REMOTE_KILL_GRACE_SEC} "$1" "$2" "$3"; else exec "$2" "$3"; fi`;

type SudoMode = "none" | "nopasswd" | "password";

const SUDO_PREFIX: Record<SudoMode, string> = {
  none: "",
  nopasswd: "sudo -n -- ",
  // -k ignores any cached timestamp so sudo ALWAYS reads the password line we
  // write; without it a cached credential would leave that line on stdin.
  password: "sudo -k -S -p '' -- ",
};

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 86_400;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CONTROL_OUTPUT_BYTES = 64 * 1024;
/** Upper bound for the probe / upload / kill channels. */
const CONTROL_CHANNEL_TIMEOUT_MS = 30_000;
/** Local deadline = remote timeout + remote kill grace + this slack. */
export const LOCAL_TIMEOUT_SLACK_MS = 5_000;
/** After a kill, how long to wait for the run channel to close before abandoning it. */
const CLOSE_AFTER_KILL_MS = 15_000;
/**
 * Exit 124 / 137 only counts as the remote `timeout` firing when the run lasted
 * at least the configured timeout minus this margin. Earlier, 124 is the
 * script's own status and 137 some other SIGKILL (typically the OOM killer).
 */
const TIMEOUT_EXIT_MARGIN_MS = 1_000;

// ---------------------------------------------------------------------------
// Output collection
// ---------------------------------------------------------------------------

/**
 * Per-stream collector: byte cap, UTF-8 decoding that never splits a multi-byte
 * character across chunks, and NUL replacement (Postgres `text` rejects \u0000,
 * so a NUL would make the runbook output flush throw).
 */
class OutputCollector {
  private readonly decoder = new StringDecoder("utf8");
  private bytes = 0;
  text = "";
  truncated = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onChunk?: (chunk: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    if (this.truncated) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const room = this.maxBytes - this.bytes;
    let keep = buf;
    if (buf.length > room) {
      keep = buf.subarray(0, Math.max(0, room));
      this.truncated = true;
    }
    this.bytes += keep.length;
    this.emit(this.decoder.write(keep));
  }

  finish(): void {
    const rest = this.decoder.end();
    // A cut in the middle of a character leaves a partial sequence behind; drop
    // it rather than surfacing a replacement character at the cut.
    if (!this.truncated) this.emit(rest);
  }

  private emit(s: string): void {
    if (!s) return;
    const clean = s.includes("\u0000") ? s.replace(/\u0000/g, "�") : s;
    this.text += clean;
    if (this.onChunk) {
      try {
        this.onChunk(clean);
      } catch {
        // A throwing consumer must not stall the stream (and with it 'close').
      }
    }
  }
}

/**
 * Removes `marker` from the very start of a stream and records whether it was
 * there. Bytes are held back only while they still match a prefix of it, so
 * output that merely resembles the marker is passed on unchanged.
 */
class LeadingMarker {
  private held: Buffer | undefined = Buffer.alloc(0);
  seen = false;

  constructor(
    private readonly marker: Buffer,
    private readonly sink: (chunk: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    if (!this.held) {
      this.sink(chunk);
      return;
    }
    const buf = this.held.length > 0 ? Buffer.concat([this.held, chunk]) : chunk;
    const n = Math.min(buf.length, this.marker.length);
    if (buf.compare(this.marker, 0, n, 0, n) !== 0) {
      this.held = undefined;
      this.sink(buf);
    } else if (buf.length < this.marker.length) {
      this.held = buf;
    } else {
      this.held = undefined;
      this.seen = true;
      if (buf.length > this.marker.length) this.sink(buf.subarray(this.marker.length));
    }
  }

  /** End of stream: a partial match was ordinary output after all. */
  flush(): void {
    const rest = this.held;
    this.held = undefined;
    if (rest && rest.length > 0) this.sink(rest);
  }
}

// ---------------------------------------------------------------------------
// One exec channel
// ---------------------------------------------------------------------------

interface ChannelOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** The channel could not be opened (or client.exec threw). */
  openError?: Error;
  /** We gave up on the channel (hard limit or abandon()) before it closed. */
  abandoned: boolean;
  /** stdout began with `stdoutMarker` (which was stripped). */
  markerSeen: boolean;
}

interface ChannelOptions {
  /** Written to the channel's stdin before it is ended. Stdin is ALWAYS ended. */
  stdin?: string;
  /** Expected at the very start of stdout; stripped, and reported as `markerSeen`. */
  stdoutMarker?: string;
  maxBytes: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Close and settle if the channel has not closed within this many ms. */
  hardLimitMs?: number;
}

interface ChannelHandle {
  done: Promise<ChannelOutcome>;
  /** Close the channel from our side and settle immediately. */
  abandon(): void;
}

function startChannel(client: Client, command: string, o: ChannelOptions): ChannelHandle {
  const stdout = new OutputCollector(o.maxBytes, o.onStdout);
  const stderr = new OutputCollector(o.maxBytes, o.onStderr);
  const leading = o.stdoutMarker
    ? new LeadingMarker(Buffer.from(o.stdoutMarker, "utf8"), (chunk) => stdout.push(chunk))
    : undefined;
  let code: number | null = null;
  let signal: string | null = null;
  let exited = false;
  let stream: ClientChannel | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (v: ChannelOutcome) => void;
  const done = new Promise<ChannelOutcome>((r) => (resolveDone = r));

  const settle = (extra: { openError?: Error; abandoned?: boolean } = {}) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    leading?.flush();
    stdout.finish();
    stderr.finish();
    resolveDone({
      code,
      signal,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      openError: extra.openError,
      abandoned: extra.abandoned ?? false,
      markerSeen: leading?.seen ?? false,
    });
  };

  const abandon = () => {
    if (settled) return;
    try {
      stream?.close();
    } catch {
      // already closing
    }
    settle({ abandoned: true });
  };

  if (o.hardLimitMs !== undefined) timer = setTimeout(abandon, o.hardLimitMs);

  try {
    client.exec(command, (err, ch) => {
      if (err) {
        settle({ openError: err });
        return;
      }
      stream = ch;
      if (settled) {
        try {
          ch.close();
        } catch {
          // ignore
        }
        return;
      }
      ch.on("data", (chunk: Buffer) => (leading ? leading.push(chunk) : stdout.push(chunk)));
      ch.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      ch.on("exit", (exitCode: number | null, exitSignal?: string) => {
        exited = true;
        code = typeof exitCode === "number" ? exitCode : null;
        signal = typeof exitSignal === "string" ? exitSignal : null;
      });
      ch.on("close", (closeCode?: number | null, closeSignal?: string) => {
        if (!exited) {
          code = typeof closeCode === "number" ? closeCode : null;
          signal = typeof closeSignal === "string" ? closeSignal : null;
        }
        settle();
      });
      // Surfaced through 'close'; an unhandled 'error' would crash the process.
      ch.on("error", () => {});
      ch.stderr.on("error", () => {});
      try {
        if (o.stdin !== undefined && o.stdin.length > 0) ch.write(o.stdin);
        ch.end();
      } catch {
        // The channel died under us; 'close' follows.
      }
    });
  } catch (err) {
    // client.exec throws synchronously when the connection is not usable.
    settle({ openError: err instanceof Error ? err : new Error(String(err)) });
  }

  return { done, abandon };
}

// ---------------------------------------------------------------------------
// sudo error mapping
// ---------------------------------------------------------------------------

/**
 * Map sudo's own diagnostics to an error code. Returns undefined when stderr
 * does not look like one of the failures below (e.g. the common
 * "sudo: unable to resolve host" warning), so a script that merely exits 1 is
 * never mislabelled.
 */
export function classifySudoFailure(stderr: string): RemoteExecErrorCode | undefined {
  if (/must have a tty|requiretty/i.test(stderr)) return "SUDO_REQUIRETTY";
  if (/incorrect password attempt|Sorry, try again/i.test(stderr)) return "SUDO_AUTH_FAILED";
  if (/is not in the sudoers file|is not allowed to (?:run|execute)|may not run sudo/i.test(stderr)) {
    return "SUDO_NOT_ALLOWED";
  }
  if (/a password is required|no password was provided|a terminal is required/i.test(stderr)) {
    return "SUDO_PASSWORD_REQUIRED";
  }
  return undefined;
}

const SUDO_MESSAGES: Record<string, string> = {
  SUDO_PASSWORD_REQUIRED: "sudo on the host requires a password and none is available for this server",
  SUDO_AUTH_FAILED: "sudo rejected the server's SSH password",
  SUDO_REQUIRETTY: "sudo on the host is configured with requiretty, which RackMap does not support",
  SUDO_NOT_ALLOWED: "the SSH user is not allowed to run commands as root with sudo",
};

// ---------------------------------------------------------------------------
// Command builders (exported for tests)
// ---------------------------------------------------------------------------

export function buildProbeCommand(interpreter: "sh" | "bash", asRoot: boolean): string {
  const parts: string[] = [];
  if (interpreter === "bash") parts.push(`printf 'I=%s\\n' "$(command -v bash 2>/dev/null)"`);
  if (asRoot) {
    parts.push(
      `u=$(id -u 2>/dev/null); printf 'U=%s\\n' "$u"; ` +
        `if [ "$u" != 0 ]; then sudo -n /bin/sh -c : </dev/null; printf 'S=%s\\n' "$?"; fi`,
    );
  }
  return parts.join("; ");
}

function buildRunCommand(sudo: SudoMode, timeoutSec: number, interpreterPath: string, remoteFile: string): string {
  const file = escapeShellArg(remoteFile);
  return (
    `${SUDO_PREFIX[sudo]}/bin/sh -c ${escapeShellArg(RUN_WRAPPER)} rackmap ` +
    `${escapeShellArg(String(timeoutSec))} ${escapeShellArg(interpreterPath)} ${file}; ` +
    `rc=$?; rm -f ${file}; exit $rc`
  );
}

/**
 * Kill everything whose command line contains the staged file, then remove it.
 *
 * The pattern is written `[/]tmp/[.]rackmap-x[.]<suffix>` and the file name is
 * passed as the bare suffix, so this command's own shell, sudo and sh processes
 * (whose argv contain this text) never match it — `pkill -f <path>` would
 * otherwise kill itself before reaching the script.
 */
export function buildKillCommand(sudo: SudoMode, remoteFile: string): string {
  const suffix = remoteFile.slice(REMOTE_FILE_PREFIX.length);
  const pattern = `[/]tmp/[.]rackmap-x[.]${suffix}`;
  const body =
    `pkill -TERM -f -- "$1" 2>/dev/null; sleep 3; pkill -KILL -f -- "$1" 2>/dev/null; ` +
    `rm -f -- "/tmp/.rackmap-x.$2"; exit 0`;
  return `${SUDO_PREFIX[sudo]}/bin/sh -c ${escapeShellArg(body)} rackmap ${escapeShellArg(pattern)} ${escapeShellArg(suffix)}`;
}

function normalizeTimeoutSec(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SEC;
  if (!Number.isFinite(value) || value < 1) throw new RangeError(`timeoutSec must be >= 1 (got ${value})`);
  return Math.min(MAX_TIMEOUT_SEC, Math.ceil(value));
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`maxOutputBytes must be >= 0 (got ${value})`);
  return Math.floor(value);
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function probeValue(stdout: string, key: string): string | undefined {
  const m = stdout.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1]!.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function execRemoteScript(client: Client, opts: RemoteScriptOptions): Promise<RemoteScriptResult> {
  // A sudo password the operator typed for this request wins over the stored one.
  const sudoOverride = currentSudoPasswordOverride();
  if (sudoOverride !== undefined) opts = { ...opts, sudoPassword: sudoOverride };
  const startedAt = Date.now();
  const interpreter = opts.interpreter ?? "sh";
  if (interpreter !== "sh" && interpreter !== "bash") throw new RangeError(`Unsupported interpreter "${interpreter}"`);
  const timeoutSec = normalizeTimeoutSec(opts.timeoutSec);
  const maxBytes = normalizeMaxBytes(opts.maxOutputBytes);
  const signal = opts.signal;

  const fail = (
    errorCode: RemoteExecErrorCode,
    errorMessage: string,
    extra: Partial<RemoteScriptResult> = {},
  ): RemoteScriptResult => ({
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: errorCode === "TIMEOUT",
    cancelled: errorCode === "CANCELLED",
    ...extra,
    errorCode,
    errorMessage,
    durationMs: Date.now() - startedAt,
  });
  const cancelledBeforeStart = () => fail("CANCELLED", "Cancelled before the script started");

  if (signal?.aborted) return cancelledBeforeStart();

  // 1. Probe: interpreter path, uid and whether sudo works without a password.
  let interpreterPath = "/bin/sh";
  let sudo: SudoMode = "none";
  if (interpreter === "bash" || opts.asRoot) {
    const probe = await startChannel(client, buildProbeCommand(interpreter, !!opts.asRoot), {
      maxBytes: CONTROL_OUTPUT_BYTES,
      hardLimitMs: CONTROL_CHANNEL_TIMEOUT_MS,
    }).done;
    if (probe.openError || probe.abandoned) {
      return fail("UPLOAD_FAILED", `Could not open an SSH channel on the host${probe.openError ? `: ${probe.openError.message}` : ""}`);
    }

    if (interpreter === "bash") {
      const found = probeValue(probe.stdout, "I") ?? "";
      if (!INTERPRETER_PATH_PATTERN.test(found)) {
        return fail("NO_INTERPRETER", "bash is not installed on the host");
      }
      interpreterPath = found;
    }

    if (opts.asRoot && probeValue(probe.stdout, "U") !== "0") {
      const sudoStatus = probeValue(probe.stdout, "S");
      if (sudoStatus === "0") {
        sudo = "nopasswd";
      } else if (sudoStatus === "127" || /sudo: (?:command )?not found/.test(probe.stderr)) {
        return fail("SUDO_NOT_ALLOWED", "sudo is not installed on the host and the SSH user is not root", {
          stderr: probe.stderr,
        });
      } else {
        const mapped = classifySudoFailure(probe.stderr);
        if (mapped === "SUDO_REQUIRETTY" || mapped === "SUDO_NOT_ALLOWED") {
          return fail(mapped, SUDO_MESSAGES[mapped]!, { stderr: probe.stderr });
        }
        const password = opts.sudoPassword;
        if (!password) {
          return fail("SUDO_PASSWORD_REQUIRED", SUDO_MESSAGES.SUDO_PASSWORD_REQUIRED!, { stderr: probe.stderr });
        }
        if (/[\r\n]/.test(password)) {
          // Only the first line would be consumed by sudo; the rest would reach the script's stdin.
          return fail("SUDO_PASSWORD_REQUIRED", "The SSH password contains a line break and cannot be passed to sudo");
        }
        sudo = "password";
      }
    }
  }
  if (signal?.aborted) return cancelledBeforeStart();

  // 2. Upload over stdin into a private mktemp file.
  const upload = await startChannel(client, UPLOAD_COMMAND, {
    stdin: opts.script,
    maxBytes: CONTROL_OUTPUT_BYTES,
    hardLimitMs: CONTROL_CHANNEL_TIMEOUT_MS,
  }).done;
  const remoteFile = lastLine(upload.stdout);
  if (upload.openError || upload.abandoned || upload.code !== 0 || !REMOTE_FILE_PATTERN.test(remoteFile)) {
    const detail = upload.openError?.message ?? (upload.stderr.trim().slice(0, 300) || `exit code ${upload.code}`);
    return fail("UPLOAD_FAILED", `Could not stage the script on the host: ${detail}`);
  }
  const sudoStdin = sudo === "password" ? `${opts.sudoPassword}\n` : undefined;
  if (signal?.aborted) {
    void startChannel(client, `rm -f ${escapeShellArg(remoteFile)}`, {
      maxBytes: CONTROL_OUTPUT_BYTES,
      hardLimitMs: CONTROL_CHANNEL_TIMEOUT_MS,
    }).done;
    return cancelledBeforeStart();
  }

  // 3. Run.
  const runStartedAt = Date.now();
  const run = startChannel(client, buildRunCommand(sudo, timeoutSec, interpreterPath, remoteFile), {
    stdin: sudoStdin,
    stdoutMarker: EXEC_STARTED_MARKER,
    maxBytes,
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
  });

  let localTimeout = false;
  let cancelled = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: "timeout" | "cancel") => {
    if (localTimeout || cancelled) return;
    if (reason === "timeout") localTimeout = true;
    else cancelled = true;
    void startChannel(client, buildKillCommand(sudo, remoteFile), {
      stdin: sudoStdin,
      maxBytes: CONTROL_OUTPUT_BYTES,
      hardLimitMs: CONTROL_CHANNEL_TIMEOUT_MS,
    }).done;
    closeTimer = setTimeout(() => run.abandon(), CLOSE_AFTER_KILL_MS);
  };
  const deadline = setTimeout(
    () => stop("timeout"),
    (timeoutSec + REMOTE_KILL_GRACE_SEC) * 1000 + LOCAL_TIMEOUT_SLACK_MS,
  );
  const onAbort = () => stop("cancel");
  signal?.addEventListener("abort", onAbort, { once: true });

  const out = await run.done;
  clearTimeout(deadline);
  if (closeTimer) clearTimeout(closeTimer);
  signal?.removeEventListener("abort", onAbort);

  if (out.openError) {
    void startChannel(client, `rm -f ${escapeShellArg(remoteFile)}`, {
      maxBytes: CONTROL_OUTPUT_BYTES,
      hardLimitMs: CONTROL_CHANNEL_TIMEOUT_MS,
    }).done;
    return fail("UPLOAD_FAILED", `Could not open an SSH channel to run the script: ${out.openError.message}`);
  }

  const result: RemoteScriptResult = {
    exitCode: out.code,
    stdout: out.stdout,
    stderr: out.stderr,
    stdoutTruncated: out.stdoutTruncated,
    stderrTruncated: out.stderrTruncated,
    timedOut: false,
    cancelled,
    durationMs: Date.now() - startedAt,
    ...(out.signal ? { exitSignal: out.signal } : {}),
  };

  // 124: `timeout` fired; 137: it had to escalate to KILL after the grace period.
  // Either status before the deadline came from the script (or another killer).
  const remoteTimeout =
    (out.code === 124 || out.code === 137) && Date.now() - runStartedAt >= timeoutSec * 1000 - TIMEOUT_EXIT_MARGIN_MS;

  if (cancelled) {
    result.errorCode = "CANCELLED";
    result.errorMessage = "The run was cancelled";
  } else if (localTimeout || remoteTimeout) {
    result.timedOut = true;
    result.errorCode = "TIMEOUT";
    result.errorMessage = `The script did not finish within ${timeoutSec}s`;
  } else if (out.code === 137) {
    result.errorMessage = "The script was killed (SIGKILL — possibly out of memory)";
  } else if (sudo !== "none" && !out.markerSeen && out.code === 1) {
    // No start marker: sudo exited 1 before the wrapper ran, so stderr is sudo's
    // own. Once the marker is out, stderr is the script's — its own `sudo -n`
    // failing is a script failure, never RackMap's sudo.
    const mapped = classifySudoFailure(out.stderr);
    if (mapped) {
      result.errorCode = mapped;
      result.errorMessage = SUDO_MESSAGES[mapped];
    }
  }
  return result;
}

/** Thin wrapper: run a /bin/sh `script` as root with a timeout; resolves with the full result. */
export async function execAsRoot(
  client: Client,
  script: string,
  password?: string,
  opts: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {},
): Promise<RemoteScriptResult> {
  return execRemoteScript(client, {
    script,
    interpreter: "sh",
    asRoot: true,
    sudoPassword: password,
    timeoutSec: opts.timeoutMs !== undefined ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : 120,
    maxOutputBytes: opts.maxOutputBytes,
    signal: opts.signal,
  });
}

/**
 * For read-only probes that used to run `sudo -n <cmd> || <cmd>`: run as root
 * when sudo is usable, otherwise re-run as the SSH user and let the script
 * degrade (partial /var/log, no /etc/sudoers) exactly as before.
 */
export async function execPreferRoot(
  client: Client,
  script: string,
  password?: string,
  opts: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {},
): Promise<RemoteScriptResult & { ranAsRoot: boolean }> {
  const asRoot = await execAsRoot(client, script, password, opts);
  if (!asRoot.errorCode?.startsWith("SUDO_")) return { ...asRoot, ranAsRoot: true };
  const plain = await execRemoteScript(client, {
    script,
    interpreter: "sh",
    asRoot: false,
    timeoutSec: opts.timeoutMs !== undefined ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : 120,
    maxOutputBytes: opts.maxOutputBytes,
    signal: opts.signal,
  });
  return { ...plain, ranAsRoot: false };
}

/** One-line, operator-facing description of a failed result. */
export function describeRemoteFailure(result: RemoteScriptResult): string {
  if (result.errorMessage) return result.errorMessage;
  const stderr = result.stderr.trim();
  if (stderr) return stderr.length > 1000 ? `${stderr.slice(0, 1000)}…` : stderr;
  if (result.exitSignal) return `killed by ${result.exitSignal}`;
  return `exit code ${result.exitCode}`;
}

/** HTTP response for a run that failed around the script rather than in it. */
export interface RemoteFailureHttp {
  status: 409 | 503 | 504;
  code: "UNREACHABLE" | "VAULT_LOCKED" | "SUDO_ERROR" | "TIMEOUT";
  message: string;
}

/**
 * The one RemoteScriptResult → HTTP mapping for failures of the transport or of
 * RackMap's own sudo:
 *
 *   UPLOAD_FAILED                                  → 503 UNREACHABLE
 *   SUDO_PASSWORD_REQUIRED / SUDO_AUTH_FAILED with
 *     passwordUnavailable "vault_locked"           → 409 VAULT_LOCKED
 *   any other SUDO_*                               → 409 SUDO_ERROR
 *   TIMEOUT                                        → 504 TIMEOUT
 *
 * Returns undefined when the script itself ran (success or its own non-zero
 * exit), was cancelled, or found no interpreter; those are the caller's to
 * report. `passwordUnavailable` is connectToServer()'s field of the same name.
 */
export function remoteFailureToHttp(
  result: RemoteScriptResult,
  opts: { passwordUnavailable?: "vault_locked" | "decrypt_failed" } = {},
): RemoteFailureHttp | undefined {
  const code = result.errorCode;
  if (code === "UPLOAD_FAILED") return { status: 503, code: "UNREACHABLE", message: describeRemoteFailure(result) };
  if (code === "TIMEOUT" || result.timedOut) {
    return { status: 504, code: "TIMEOUT", message: describeRemoteFailure(result) };
  }
  if (code?.startsWith("SUDO_")) {
    const wantsPassword = code === "SUDO_PASSWORD_REQUIRED" || code === "SUDO_AUTH_FAILED";
    if (wantsPassword && opts.passwordUnavailable === "vault_locked") {
      // Unlocking the vault (or sending x-ssh-password) fixes this; say so.
      return { status: 409, code: "VAULT_LOCKED", message: `sudo on the host requires a password. ${VAULT_LOCKED_MESSAGE}` };
    }
    let message = describeRemoteFailure(result);
    if (wantsPassword && opts.passwordUnavailable === "decrypt_failed") {
      message += " (the stored server password could not be decrypted; re-enter it or check APP_ENCRYPTION_KEY)";
    }
    return { status: 409, code: "SUDO_ERROR", message };
  }
  return undefined;
}

/** Throwable form of a remoteFailureToHttp() result, for services whose routes map thrown errors. */
export class RemoteFailureError extends Error {
  readonly status: RemoteFailureHttp["status"];
  readonly code: RemoteFailureHttp["code"];

  constructor(failure: RemoteFailureHttp, message = failure.message) {
    super(message);
    this.name = "RemoteFailureError";
    this.status = failure.status;
    this.code = failure.code;
  }
}
