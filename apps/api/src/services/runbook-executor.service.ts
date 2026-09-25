import pLimit, { type LimitFunction } from "p-limit";
import type { RunbookHostErrorCode, RunbookRunStatus, RunbookRunSummary } from "@inv/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { writeAuditDirect } from "../lib/audit.js";
import { INSTANCE_ID } from "./job-lock.service.js";
import { connectToServer, SshError } from "./ssh.service.js";
import { execRemoteScript, RemoteExecError, type RemoteScriptResult } from "./remote-exec.service.js";
import { emitAlert } from "./alerting/emit.js";
import { buildPrelude, composeRunbookScript, createSecretMasker, type SecretMasker } from "./runbook-params.js";
import { decodeRunParams } from "./runbook-run-factory.js";

/**
 * The runbook executor: claims queued runs and fans each one out over SSH.
 *
 * Multi-replica model
 * -------------------
 * There is no global lock around execution. Any replica may pick up any queued
 * run; the claim is one conditional UPDATE (`status: queued → running`,
 * `claimedBy: INSTANCE_ID`) and `count === 1` is the verdict, so two replicas
 * racing for one run produce exactly one winner. The winner then proves it is
 * alive by bumping `heartbeatAt`; the reaper (runbook-background.ts, under a job
 * lock) fails runs whose heartbeat went stale — "executor lost" — because the
 * replica that owned them is gone. Runs are never retried automatically: the
 * command may still be running on the host.
 *
 * Output
 * ------
 * Output is persisted in chunks (appended with SQL every FLUSH_MS) and the
 * browser polls for it. That works whichever replica runs the job and survives
 * the proxy's read timeout; the stored output doubles as the run history.
 * Secret parameter values are masked BEFORE anything is stored.
 */

const FLUSH_MS = 1_500;
const CANCEL_CHECK_MS = 2_000;
const HEARTBEAT_MS = 10_000;
const DRY_RUN_TIMEOUT_SEC = 30;
/** A running run whose heartbeat is older than this belongs to a dead executor. */
export const RUNBOOK_STALE_MS = 60_000;

export const EXECUTOR_LOST_MESSAGE = "Executor lost (the API instance running it stopped). The command may still be running on the host.";

/**
 * The dry-run probe. It never runs the runbook's script, which is why a dry run
 * needs no approval: it only answers "can we connect, as whom, is bash there,
 * would sudo work without a password?".
 */
export const DRY_RUN_PROBE = [
  'echo "user: $(id -un)"',
  'if command -v bash >/dev/null 2>&1; then echo "bash: $(command -v bash)"; else echo "bash: not found"; fi',
  'if sudo -n true 2>/dev/null; then echo "SUDO_OK"; else echo "SUDO_NEEDS_PASSWORD"; fi',
  "exit 0",
  "",
].join("\n");

// ─── Per-host execution contract ─────────────────────────────────────────────

export interface ExecRun {
  id: number;
  runbookId: number;
  interpreter: "bash" | "sh";
  runAs: "root" | "sshUser";
  timeoutSec: number;
  dryRun: boolean;
}

export interface RunOnHostDeps {
  /** The full file to upload: prelude + script, or the dry-run probe. */
  script: string;
  interpreter: "bash" | "sh";
  asRoot: boolean;
  timeoutSec: number;
  maxOutputBytes: number;
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  signal: AbortSignal;
}

export type HostFinalStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

export interface HostOutcome {
  status: HostFinalStatus;
  errorCode?: RunbookHostErrorCode | null;
  exitCode?: number | null;
  /** Operator-facing reason, appended to the host's stderr as `rackmap: …`. */
  message?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** Full output, used only when the implementation did not stream through onStdout/onStderr. */
  stdout?: string;
  stderr?: string;
}

/** Injectable so tests (and future transports) never need a real SSH connection. */
export type RunOnHost = (run: ExecRun, serverId: number, deps: RunOnHostDeps) => Promise<HostOutcome>;

/** SshError from connectToServer → host outcome. */
export function mapConnectError(err: unknown): HostOutcome {
  if (err instanceof SshError) {
    switch (err.kind) {
      case "vault_locked":
        return {
          status: "failed",
          errorCode: "VAULT_LOCKED",
          message: "Vault is locked: this host's password is vault-encrypted. Set VAULT_PASSPHRASE or unlock the vault globally.",
        };
      case "no_credentials":
        return { status: "failed", errorCode: "NO_CREDENTIALS", message: err.message };
      case "not_found":
        return { status: "failed", errorCode: "NOT_FOUND", message: "Server not found (deleted?)" };
      case "auth_failed":
        return { status: "failed", errorCode: "AUTH_FAILED", message: err.message };
      case "host_key_changed":
        return { status: "failed", errorCode: "HOST_KEY_CHANGED", message: err.message };
      case "unreachable":
        return { status: "failed", errorCode: "UNREACHABLE", message: err.message };
    }
  }
  return { status: "failed", errorCode: "UNREACHABLE", message: err instanceof Error ? err.message : "SSH connection failed" };
}

/** RemoteScriptResult → host outcome. `passwordUnavailable` explains a sudo failure. */
export function mapExecResult(
  res: RemoteScriptResult,
  conn: { passwordUnavailable?: "vault_locked" | "decrypt_failed" } = {},
): HostOutcome {
  const base = { exitCode: res.exitCode, stdoutTruncated: res.stdoutTruncated, stderrTruncated: res.stderrTruncated };
  if (res.cancelled || res.errorCode === "CANCELLED") return { ...base, status: "cancelled", errorCode: "CANCELLED" };
  if (res.timedOut || res.errorCode === "TIMEOUT") return { ...base, status: "timed_out", errorCode: "TIMEOUT" };
  if (res.errorCode) {
    // sudo wanted a password we could not produce because the vault is locked:
    // report the actionable cause, not "a password is required".
    if (res.errorCode === "SUDO_PASSWORD_REQUIRED" && conn.passwordUnavailable === "vault_locked") {
      return {
        ...base,
        status: "failed",
        errorCode: "VAULT_LOCKED",
        message: "sudo needs this host's password, which is vault-encrypted and the vault is locked.",
      };
    }
    return { ...base, status: "failed", errorCode: res.errorCode };
  }
  if (res.exitCode === 0) return { ...base, status: "succeeded", errorCode: null };
  return { ...base, status: "failed", errorCode: "NONZERO_EXIT" };
}

/** The production transport: connectToServer + execRemoteScript. */
export const defaultRunOnHost: RunOnHost = async (_run, serverId, deps) => {
  let conn: Awaited<ReturnType<typeof connectToServer>>;
  try {
    conn = await connectToServer(serverId);
  } catch (err) {
    return mapConnectError(err);
  }
  try {
    const res = await execRemoteScript(conn.client, {
      script: deps.script,
      interpreter: deps.interpreter,
      asRoot: deps.asRoot,
      sudoPassword: conn.password,
      timeoutSec: deps.timeoutSec,
      maxOutputBytes: deps.maxOutputBytes,
      onStdout: deps.onStdout,
      onStderr: deps.onStderr,
      signal: deps.signal,
    });
    return mapExecResult(res, conn);
  } catch (err) {
    if (err instanceof RemoteExecError) {
      return mapExecResult(
        {
          exitCode: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: err.code === "TIMEOUT",
          cancelled: err.code === "CANCELLED",
          durationMs: 0,
          errorCode: err.code,
        },
        conn,
      );
    }
    return { status: "failed", errorCode: "EXEC_FAILED", message: err instanceof Error ? err.message : "Execution failed" };
  } finally {
    try {
      conn.client.end();
    } catch {
      /* already closed */
    }
  }
};

// ─── Output buffering ────────────────────────────────────────────────────────

/** Cut `s` to at most `maxBytes` of UTF-8 without splitting a character. */
function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

class StreamBuffer {
  pending = "";
  bytes = 0;
  truncated = false;
  constructor(
    private masker: SecretMasker,
    private maxBytes: number,
  ) {}

  push(chunk: string) {
    this.accept(this.masker.push(chunk));
  }

  end() {
    this.accept(this.masker.flush());
  }

  /** Text that bypasses the masker (rackmap's own notes — never contain secrets). */
  note(text: string) {
    this.accept(this.masker.flush() + text);
  }

  private accept(text: string) {
    if (!text) return;
    // Postgres `text` rejects NUL; the flush would throw and lose the chunk.
    const clean = text.replace(/\u0000/g, "�");
    if (this.truncated) return;
    const room = this.maxBytes - this.bytes;
    const len = Buffer.byteLength(clean, "utf8");
    if (len <= room) {
      this.pending += clean;
      this.bytes += len;
      return;
    }
    const cut = truncateUtf8(clean, room);
    this.pending += cut;
    this.bytes += Buffer.byteLength(cut, "utf8");
    this.truncated = true;
  }

  take(): string {
    const out = this.pending;
    this.pending = "";
    return out;
  }
}

class HostOutput {
  readonly out: StreamBuffer;
  readonly err: StreamBuffer;
  /** Whether the transport streamed anything (else its final result is used). */
  streamed = false;
  private chain: Promise<void> = Promise.resolve();
  private flushedTruncOut = false;
  private flushedTruncErr = false;

  constructor(
    readonly rowId: number,
    secrets: string[],
    maxBytes: number,
  ) {
    this.out = new StreamBuffer(createSecretMasker(secrets), maxBytes);
    this.err = new StreamBuffer(createSecretMasker(secrets), maxBytes);
  }

  /** Append pending output with SQL. Serialized per host, so chunks land in order. */
  flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const out = this.out.take();
      const err = this.err.take();
      const truncOut = this.out.truncated && !this.flushedTruncOut;
      const truncErr = this.err.truncated && !this.flushedTruncErr;
      if (!out && !err && !truncOut && !truncErr) return;
      try {
        await prisma.$executeRaw`
          UPDATE runbook_host_result
          SET "stdout" = "stdout" || ${out},
              "stderr" = "stderr" || ${err},
              "stdoutTruncated" = ("stdoutTruncated" OR ${truncOut}),
              "stderrTruncated" = ("stderrTruncated" OR ${truncErr})
          WHERE "id" = ${this.rowId}`;
        if (truncOut) this.flushedTruncOut = true;
        if (truncErr) this.flushedTruncErr = true;
      } catch (e) {
        // Put the text back so the next flush retries it rather than losing it.
        this.out.pending = out + this.out.pending;
        this.err.pending = err + this.err.pending;
        console.warn(`[runbooks] output flush failed for host row ${this.rowId}:`, e);
      }
    });
    return this.chain;
  }
}

// ─── Claiming ────────────────────────────────────────────────────────────────

/**
 * Take the oldest queued run for `holder`. Returns its id, or null when there is
 * nothing to do. The UPDATE's `status: "queued"` predicate is what makes this
 * race-free across replicas; losing a race just means trying the next one.
 */
export async function claimNextRun(holder: string = INSTANCE_ID): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await prisma.runbookRun.findFirst({
      where: { status: "queued" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!candidate) return null;
    const now = new Date();
    const { count } = await prisma.runbookRun.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "running", claimedBy: holder, claimedAt: now, heartbeatAt: now, startedAt: now },
    });
    if (count === 1) return candidate.id;
  }
  return null;
}

// ─── Executing one run ───────────────────────────────────────────────────────

export interface ExecuteRunOptions {
  holder?: string;
  runOnHost?: RunOnHost;
  /** Shared SSH-session limiter; defaults to the process-wide one. */
  globalLimit?: LimitFunction;
  flushIntervalMs?: number;
  cancelCheckIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxOutputBytes?: number;
  /** Aborted on shutdown: hosts are cancelled and the run fails with "shutdown". */
  signal?: AbortSignal;
}

let processLimit: LimitFunction | null = null;
function globalSshLimit(): LimitFunction {
  processLimit ??= pLimit(env.RUNBOOK_MAX_SSH_SESSIONS);
  return processLimit;
}

function emptySummary(): RunbookRunSummary {
  return { total: 0, succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, skipped: 0 };
}

export function summarize(statuses: string[]): RunbookRunSummary {
  const s = emptySummary();
  for (const st of statuses) {
    s.total++;
    if (st === "succeeded") s.succeeded++;
    else if (st === "timed_out") s.timedOut++;
    else if (st === "cancelled") s.cancelled++;
    else if (st === "skipped") s.skipped++;
    else s.failed++;
  }
  return s;
}

/**
 * Execute a run this holder has claimed. Resolves with the final status, or null
 * when the run is not ours (never claimed, or taken away by the reaper).
 */
export async function executeRun(runId: number, opts: ExecuteRunOptions = {}): Promise<RunbookRunStatus | null> {
  const holder = opts.holder ?? INSTANCE_ID;
  const runOnHost = opts.runOnHost ?? defaultRunOnHost;
  const maxOutputBytes = opts.maxOutputBytes ?? env.RUNBOOK_OUTPUT_MAX_BYTES;

  const run = await prisma.runbookRun.findUnique({
    where: { id: runId },
    include: {
      runbook: { select: { name: true } },
      hostResults: { select: { id: true, serverId: true, hostname: true, status: true }, orderBy: { id: "asc" } },
    },
  });
  if (!run || run.status !== "running" || run.claimedBy !== holder) return null;

  const execRun: ExecRun = {
    id: run.id,
    runbookId: run.runbookId,
    interpreter: run.interpreter === "sh" ? "sh" : "bash",
    runAs: run.runAs === "root" ? "root" : "sshUser",
    timeoutSec: run.timeoutSec,
    dryRun: run.dryRun,
  };

  const params = run.dryRun ? { v: 1 as const, defs: [], values: {} } : decodeRunParams(run.paramsEnc);
  if (!params) {
    // APP_ENCRYPTION_KEY changed since the run was requested. Nothing can run safely.
    await failWholeRun(run.id, holder, "EXEC_FAILED", "Run parameters could not be decrypted (APP_ENCRYPTION_KEY changed?)");
    return "failed";
  }
  const secretNames = new Set(params.defs.filter((d) => d.type === "secret").map((d) => d.name));
  const secrets = Object.entries(params.values)
    .filter(([k]) => secretNames.has(k))
    .map(([, v]) => v);

  const controller = new AbortController();
  const state = { cancelled: false, lost: false, shutdown: false, failures: 0, stopped: false, vaultLocked: false };
  const onExternalAbort = () => {
    state.shutdown = true;
    controller.abort();
  };
  if (opts.signal?.aborted) onExternalAbort();
  else opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const outputs = new Set<HostOutput>();
  const flushAll = () => Promise.all([...outputs].map((o) => o.flush()));

  const flushTimer = setInterval(() => void flushAll(), opts.flushIntervalMs ?? FLUSH_MS);
  const cancelTimer = setInterval(() => {
    void prisma.runbookRun
      .findUnique({ where: { id: run.id }, select: { status: true, claimedBy: true, cancelRequestedAt: true } })
      .then((r) => {
        if (!r || r.status !== "running" || r.claimedBy !== holder) {
          state.lost = true;
          controller.abort();
        } else if (r.cancelRequestedAt && !state.cancelled) {
          state.cancelled = true;
          controller.abort();
        }
      })
      .catch((err) => console.warn(`[runbooks] cancel check failed for run ${run.id}:`, err));
  }, opts.cancelCheckIntervalMs ?? CANCEL_CHECK_MS);
  const heartbeatTimer = setInterval(() => {
    void prisma.runbookRun
      .updateMany({ where: { id: run.id, status: "running", claimedBy: holder }, data: { heartbeatAt: new Date() } })
      .then(({ count }) => {
        if (count === 0) {
          state.lost = true;
          controller.abort();
        }
      })
      .catch((err) => console.warn(`[runbooks] heartbeat failed for run ${run.id}:`, err));
  }, opts.heartbeatIntervalMs ?? HEARTBEAT_MS);
  for (const t of [flushTimer, cancelTimer, heartbeatTimer]) t.unref?.();

  const perRun = pLimit(Math.max(1, run.concurrency));
  const global = opts.globalLimit ?? globalSshLimit();

  const settleHost = async (rowId: number, from: string[], data: Record<string, unknown>) => {
    await prisma.runbookHostResult.updateMany({ where: { id: rowId, status: { in: from } }, data });
  };

  const runHost = async (h: (typeof run.hostResults)[number]) => {
    if (controller.signal.aborted) {
      await settleHost(h.id, ["pending"], { status: "cancelled", errorCode: "CANCELLED", finishedAt: new Date() });
      return;
    }
    if (state.stopped) {
      await settleHost(h.id, ["pending"], { status: "skipped", finishedAt: new Date() });
      return;
    }
    const startedAt = new Date();
    const claimed = await prisma.runbookHostResult.updateMany({
      where: { id: h.id, status: "pending" },
      data: { status: "running", startedAt },
    });
    if (claimed.count !== 1) return;

    const output = new HostOutput(h.id, secrets, maxOutputBytes);
    outputs.add(output);

    const produce = async (): Promise<HostOutcome> => {
      if (h.serverId === null) return { status: "failed", errorCode: "NOT_FOUND", message: "Server was deleted" };
      let script: string;
      try {
        script = run.dryRun
          ? DRY_RUN_PROBE
          : composeRunbookScript(
              buildPrelude(params.defs, params.values, { runId: run.id, serverId: h.serverId, hostname: h.hostname }),
              run.scriptSnapshot,
            );
      } catch (err) {
        return { status: "failed", errorCode: "EXEC_FAILED", message: err instanceof Error ? err.message : "Invalid parameters" };
      }
      try {
        return await runOnHost(execRun, h.serverId, {
          script,
          interpreter: run.dryRun ? "sh" : execRun.interpreter,
          // The probe runs as the SSH user and tests `sudo -n` itself.
          asRoot: !run.dryRun && execRun.runAs === "root",
          timeoutSec: run.dryRun ? DRY_RUN_TIMEOUT_SEC : run.timeoutSec,
          maxOutputBytes,
          onStdout: (chunk) => {
            output.streamed = true;
            output.out.push(chunk);
          },
          onStderr: (chunk) => {
            output.streamed = true;
            output.err.push(chunk);
          },
          signal: controller.signal,
        });
      } catch (err) {
        return { status: "failed", errorCode: "EXEC_FAILED", message: err instanceof Error ? err.message : "Execution failed" };
      }
    };
    const outcome = await produce();

    if (!output.streamed) {
      if (outcome.stdout) output.out.push(outcome.stdout);
      if (outcome.stderr) output.err.push(outcome.stderr);
    }
    output.out.end();
    output.err.end();
    if (outcome.message) output.err.note(`${output.err.bytes > 0 ? "\n" : ""}rackmap: ${outcome.message}\n`);
    await output.flush();
    outputs.delete(output);

    const finishedAt = new Date();
    await settleHost(h.id, ["running"], {
      status: outcome.status,
      errorCode: outcome.errorCode ?? null,
      exitCode: outcome.exitCode ?? null,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      stdoutTruncated: output.out.truncated || Boolean(outcome.stdoutTruncated),
      stderrTruncated: output.err.truncated || Boolean(outcome.stderrTruncated),
    });

    if (outcome.errorCode === "VAULT_LOCKED") state.vaultLocked = true;
    if (outcome.status === "failed" || outcome.status === "timed_out") {
      state.failures++;
      if (run.maxFailures !== null && state.failures >= run.maxFailures) state.stopped = true;
    }
  };

  try {
    await Promise.all(
      run.hostResults
        .filter((h) => h.status === "pending")
        .map((h) => perRun(() => global(() => runHost(h)))),
    );
  } finally {
    clearInterval(flushTimer);
    clearInterval(cancelTimer);
    clearInterval(heartbeatTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    await flushAll();
  }

  // The reaper already failed this run (our heartbeat went stale); it owns the outcome.
  if (state.lost) return null;
  return finalizeRun(run.id, holder, state, run.maxFailures);
}

async function finalizeRun(
  runId: number,
  holder: string,
  state: { cancelled: boolean; shutdown: boolean; stopped: boolean; failures: number; vaultLocked: boolean },
  maxFailures: number | null,
): Promise<RunbookRunStatus | null> {
  const hosts = await prisma.runbookHostResult.findMany({
    where: { runId },
    select: { status: true, hostname: true, errorCode: true },
  });
  const summary = summarize(hosts.map((h) => h.status));

  let status: RunbookRunStatus;
  let error: string | null = null;
  if (state.shutdown) {
    status = "failed";
    error = "shutdown";
  } else if (state.cancelled) {
    status = "cancelled";
  } else if (state.stopped) {
    status = "failed";
    error = `Stopped after ${state.failures} failed host(s) (maxFailures ${maxFailures}); remaining hosts skipped.`;
  } else if (summary.total > 0 && summary.succeeded === summary.total) {
    status = "succeeded";
  } else if (summary.succeeded === 0) {
    status = "failed";
  } else {
    status = "partially_failed";
  }

  const finishedAt = new Date();
  const { count } = await prisma.runbookRun.updateMany({
    where: { id: runId, status: "running", claimedBy: holder },
    data: { status, finishedAt, summary: summary as object, error },
  });
  if (count !== 1) return null;

  await afterRunFinished(runId, status, summary, {
    failedHosts: hosts.filter((h) => h.status !== "succeeded" && h.status !== "skipped").map((h) => h.hostname),
    vaultLocked: state.vaultLocked,
  });
  return status;
}

/** Audit, alerts and the vault-locked notice for a run that just reached a terminal state. */
async function afterRunFinished(
  runId: number,
  status: RunbookRunStatus,
  summary: RunbookRunSummary,
  extra: { failedHosts: string[]; vaultLocked: boolean },
) {
  const run = await prisma.runbookRun.findUnique({
    where: { id: runId },
    select: { id: true, runbookId: true, dryRun: true, triggeredBy: true, runbook: { select: { name: true } } },
  });
  if (!run) return;

  await writeAuditDirect({
    ctx: { actorId: null, actorEmail: null, ip: null },
    category: "data",
    action: "runbook.run_finished",
    entity: "RunbookRun",
    entityId: String(run.id),
    after: { runbookId: run.runbookId, status, summary, dryRun: run.dryRun, triggeredBy: run.triggeredBy },
  }).catch((err) => console.warn("[runbooks] audit write failed:", err));

  const name = run.runbook.name;
  // A dry run only probes connectivity; its failures must not page anyone.
  if (!run.dryRun) {
    const dedupKey = `rackmap:runbook:${run.runbookId}`;
    try {
      if (status === "failed" || status === "partially_failed") {
        const bad = summary.total - summary.succeeded - summary.skipped;
        await emitAlert({
          type: "runbook_failed",
          severity: "error",
          action: "trigger",
          dedupKey,
          title: `Runbook "${name}" ${status === "failed" ? "failed" : "partially failed"}`,
          summary:
            `${bad} of ${summary.total} host(s) did not succeed` +
            (extra.failedHosts.length ? `: ${extra.failedHosts.slice(0, 10).join(", ")}${extra.failedHosts.length > 10 ? ", …" : ""}` : ""),
          payload: { runId: run.id, runbookId: run.runbookId, status, summary },
          runbookRunId: run.id,
        });
      } else if (status === "succeeded") {
        await emitAlert({
          type: "runbook_succeeded",
          severity: "info",
          action: "resolve",
          dedupKey,
          title: `Runbook "${name}" succeeded`,
          summary: `Succeeded on all ${summary.total} host(s)`,
          payload: { runId: run.id, runbookId: run.runbookId, status, summary },
          runbookRunId: run.id,
        });
      }
    } catch (err) {
      console.warn("[runbooks] alert emit failed:", err);
    }
  }

  if (extra.vaultLocked) {
    await notifyVaultLocked(run.runbookId, name, run.id).catch((err) => console.warn("[runbooks] vault notice failed:", err));
  }
}

const VAULT_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One `system` event per runbook per day when hosts failed with VAULT_LOCKED.
 * Deduplicated through the event log itself, so it holds across replicas and
 * restarts. Returns whether an event was emitted.
 */
export async function notifyVaultLocked(runbookId: number, runbookName: string, runId: number, now = new Date()): Promise<boolean> {
  const dedupKey = `rackmap:runbook-vault:${runbookId}`;
  const recent = await prisma.alertEvent.findFirst({
    where: { type: "system", dedupKey, createdAt: { gte: new Date(now.getTime() - VAULT_NOTICE_WINDOW_MS) } },
    select: { id: true },
  });
  if (recent) return false;
  await emitAlert({
    type: "system",
    severity: "warning",
    action: "info",
    dedupKey,
    title: `Runbook "${runbookName}": hosts skipped, vault locked`,
    summary:
      "Some hosts store a vault-encrypted password and the vault is locked, so background runs cannot use it. " +
      "Set VAULT_PASSPHRASE or unlock the vault globally.",
    payload: { runbookId, runId },
    runbookRunId: runId,
  });
  return true;
}

/** Fail a run we own before any host started (e.g. undecryptable parameters). */
async function failWholeRun(runId: number, holder: string, errorCode: RunbookHostErrorCode, message: string) {
  const now = new Date();
  await prisma.runbookHostResult.updateMany({
    where: { runId, status: { in: ["pending", "running"] } },
    data: { status: "failed", errorCode, finishedAt: now, stderr: `rackmap: ${message}\n` },
  });
  const hosts = await prisma.runbookHostResult.findMany({ where: { runId }, select: { status: true, hostname: true } });
  const summary = summarize(hosts.map((h) => h.status));
  const { count } = await prisma.runbookRun.updateMany({
    where: { id: runId, status: "running", claimedBy: holder },
    data: { status: "failed", finishedAt: now, summary: summary as object, error: message },
  });
  if (count === 1) {
    await afterRunFinished(runId, "failed", summary, { failedHosts: hosts.map((h) => h.hostname), vaultLocked: false });
  }
}

// ─── Reaper ──────────────────────────────────────────────────────────────────

/**
 * Fail runs whose executor died, and expire approvals nobody acted on.
 *
 * A stale heartbeat means the replica that claimed the run is gone (crash, kill
 * -9, lost network). Its hosts are marked EXECUTOR_LOST rather than retried: the
 * command may well have completed, or still be running, on the host.
 */
export async function reapRunbookRuns(
  now: Date = new Date(),
  opts: { staleMs?: number; approvalTtlMs?: number } = {},
): Promise<{ lost: number; expired: number }> {
  const cutoff = new Date(now.getTime() - (opts.staleMs ?? RUNBOOK_STALE_MS));
  const staleWhere = { status: "running", OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null }] };

  let lost = 0;
  const stale = await prisma.runbookRun.findMany({ where: staleWhere, select: { id: true } });
  for (const { id } of stale) {
    const { count } = await prisma.runbookRun.updateMany({
      where: { id, ...staleWhere },
      data: { status: "failed", finishedAt: now, error: EXECUTOR_LOST_MESSAGE },
    });
    if (count !== 1) continue;
    lost++;
    await markHostsLost(id, now);
    const hosts = await prisma.runbookHostResult.findMany({ where: { runId: id }, select: { status: true, hostname: true } });
    const summary = summarize(hosts.map((h) => h.status));
    await prisma.runbookRun.update({ where: { id }, data: { summary: summary as object } });
    await afterRunFinished(id, "failed", summary, {
      failedHosts: hosts.filter((h) => h.status === "failed").map((h) => h.hostname),
      vaultLocked: false,
    });
  }

  const ttlMs = opts.approvalTtlMs ?? env.RUNBOOK_APPROVAL_TTL_HOURS * 60 * 60 * 1000;
  let expired = 0;
  const pending = await prisma.runbookRun.findMany({
    where: { status: "pending_approval", createdAt: { lt: new Date(now.getTime() - ttlMs) } },
    select: { id: true },
  });
  for (const { id } of pending) {
    const { count } = await prisma.runbookRun.updateMany({
      where: { id, status: "pending_approval" },
      data: { status: "expired", finishedAt: now, error: "Not approved in time" },
    });
    if (count !== 1) continue;
    expired++;
    await prisma.runbookHostResult.updateMany({ where: { runId: id, status: "pending" }, data: { status: "skipped", finishedAt: now } });
  }

  return { lost, expired };
}

async function markHostsLost(runId: number, now: Date) {
  await prisma.runbookHostResult.updateMany({
    where: { runId, status: "running" },
    data: { status: "failed", errorCode: "EXECUTOR_LOST", finishedAt: now },
  });
  await prisma.runbookHostResult.updateMany({
    where: { runId, status: "pending" },
    data: { status: "skipped", errorCode: "EXECUTOR_LOST", finishedAt: now },
  });
}

/** Shutdown: fail every run this instance still holds, so nobody waits for the reaper. */
export async function markOwnRunsFailed(holder: string = INSTANCE_ID, reason = "shutdown"): Promise<number> {
  const now = new Date();
  const runs = await prisma.runbookRun.findMany({ where: { status: "running", claimedBy: holder }, select: { id: true } });
  let n = 0;
  for (const { id } of runs) {
    const { count } = await prisma.runbookRun.updateMany({
      where: { id, status: "running", claimedBy: holder },
      data: { status: "failed", finishedAt: now, error: reason },
    });
    if (count !== 1) continue;
    n++;
    await markHostsLost(id, now);
    const hosts = await prisma.runbookHostResult.findMany({ where: { runId: id }, select: { status: true } });
    await prisma.runbookRun.update({ where: { id }, data: { summary: summarize(hosts.map((h) => h.status)) as object } });
  }
  return n;
}

// ─── Worker loop ─────────────────────────────────────────────────────────────

const TICK_MS = 2_000;

let workerStarted = false;
let workerTimer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let workerOptions: ExecuteRunOptions = {};
const active = new Map<number, { promise: Promise<unknown>; controller: AbortController }>();

async function workerTick() {
  if (ticking || !workerStarted) return;
  ticking = true;
  try {
    while (workerStarted && active.size < env.RUNBOOK_MAX_CONCURRENT_RUNS) {
      const id = await claimNextRun(workerOptions.holder ?? INSTANCE_ID);
      if (id === null) break;
      launch(id);
    }
  } catch (err) {
    console.error("[runbooks] worker tick failed:", err);
  } finally {
    ticking = false;
    if (workerStarted) {
      if (workerTimer) clearTimeout(workerTimer);
      workerTimer = setTimeout(() => void workerTick(), TICK_MS);
      workerTimer.unref?.();
    }
  }
}

function launch(runId: number) {
  const controller = new AbortController();
  const holder = workerOptions.holder ?? INSTANCE_ID;
  const promise = executeRun(runId, { ...workerOptions, signal: controller.signal })
    .catch(async (err) => {
      console.error(`[runbooks] run ${runId} crashed:`, err);
      await failWholeRun(runId, holder, "EXEC_FAILED", "Executor error").catch(() => {});
    })
    .finally(() => {
      active.delete(runId);
      kickRunbookWorker();
    });
  active.set(runId, { promise, controller });
}

export function startRunbookWorker(opts: ExecuteRunOptions = {}): void {
  if (workerStarted) return;
  workerStarted = true;
  workerOptions = opts;
  console.log(
    `[runbooks] worker starting — ${env.RUNBOOK_MAX_CONCURRENT_RUNS} concurrent run(s), ${env.RUNBOOK_MAX_SSH_SESSIONS} SSH session(s)`,
  );
  workerTimer = setTimeout(() => void workerTick(), TICK_MS);
  workerTimer.unref?.();
}

/** Look for work now instead of at the next tick. A no-op unless the worker runs in this process. */
export function kickRunbookWorker(): void {
  if (!workerStarted) return;
  setImmediate(() => void workerTick());
}

/**
 * Stop claiming, abort in-flight hosts (which triggers the remote pkill path),
 * give them a moment to report, then — on shutdown — fail whatever we still hold.
 */
export async function stopRunbookWorker(opts: { markOwnFailed?: boolean; graceMs?: number } = {}): Promise<void> {
  workerStarted = false;
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  const inflight = [...active.values()];
  for (const r of inflight) r.controller.abort();
  if (inflight.length) {
    await Promise.race([
      Promise.allSettled(inflight.map((r) => r.promise)),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, opts.graceMs ?? 5_000);
        t.unref?.();
      }),
    ]);
  }
  if (opts.markOwnFailed) await markOwnRunsFailed(workerOptions.holder ?? INSTANCE_ID, "shutdown");
}
