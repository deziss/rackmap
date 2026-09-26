import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import pLimit from "p-limit";
import type { AlertEventInput } from "../services/alerting/emit.js";
import type { HostOutcome, RunOnHost } from "../services/runbook-executor.service.js";

// Record alerts in the event table (so the once-a-day vault notice can dedupe
// against it) without depending on channel fan-out.
const emitted: AlertEventInput[] = [];
vi.mock("../services/alerting/emit.js", async () => {
  const { prisma } = await import("../db.js");
  return {
    emitAlert: vi.fn(async (e: AlertEventInput) => {
      emitted.push(e);
      const ev = await prisma.alertEvent.create({
        data: {
          type: e.type,
          severity: e.severity,
          action: e.action ?? "info",
          dedupKey: e.dedupKey ?? null,
          title: e.title,
          summary: e.summary,
          runbookRunId: e.runbookRunId ?? null,
        },
      });
      return { eventId: ev.id, queued: 0 };
    }),
  };
});

const { prisma } = await import("../db.js");
const { SshError } = await import("../services/ssh.service.js");
const {
  claimNextRun,
  executeRun,
  mapConnectError,
  mapExecResult,
  markOwnRunsFailed,
  reapRunbookRuns,
} = await import("../services/runbook-executor.service.js");
const { insertRun } = await import("../services/runbook-run-factory.js");
const { runRunbookScheduleTick } = await import("../services/runbook-scheduler.js");
const { RunbookParamDef } = await import("@inv/shared");

/**
 * The executor with an injected transport: no SSH anywhere. What is under test
 * is the orchestration — claiming, limits, stop conditions, cancellation, output
 * persistence, liveness — which is where a fleet tool does real damage when it
 * is wrong.
 */

const HOLDER = "test-holder-A";
const FAST = { flushIntervalMs: 20, cancelCheckIntervalMs: 20, heartbeatIntervalMs: 50 };

let runbookId = 0;
let serverIds: number[] = [];

beforeAll(async () => {
  const servers = [];
  for (let i = 0; i < 6; i++) {
    servers.push(
      await prisma.server.create({
        data: { hostname: `rbx-${i}.example.com`, ip: `198.51.100.${i + 1}`, username: "ops" },
      }),
    );
  }
  serverIds = servers.map((s) => s.id);
  const rb = await prisma.runbook.create({
    data: { name: "rbx-executor", script: "echo hi", targetSelector: { serverIds } },
  });
  runbookId = rb.id;
});

afterEach(async () => {
  emitted.length = 0;
  await prisma.runbookRun.deleteMany({ where: { runbookId } });
  await prisma.alertEvent.deleteMany({ where: { OR: [{ dedupKey: { startsWith: "rackmap:runbook" } }, { type: "runbook_failed" }] } });
});

afterAll(async () => {
  await prisma.runbookRun.deleteMany({ where: { runbook: { name: { startsWith: "rbx-" } } } });
  await prisma.runbook.deleteMany({ where: { name: { startsWith: "rbx-" } } });
  await prisma.server.deleteMany({ where: { hostname: { startsWith: "rbx-" } } });
  await prisma.systemLicense.deleteMany({});
});

async function makeRun(opts: {
  hosts?: number;
  concurrency?: number;
  maxFailures?: number | null;
  status?: "queued" | "pending_approval";
  secret?: string;
  dryRun?: boolean;
}) {
  const rb = await prisma.runbook.findUniqueOrThrow({ where: { id: runbookId } });
  const defs = opts.secret ? [RunbookParamDef.parse({ name: "TOKEN", type: "secret" })] : [];
  const runId = await insertRun({
    runbook: { ...rb, concurrency: opts.concurrency ?? 5, maxFailures: opts.maxFailures ?? null },
    servers: serverIds.slice(0, opts.hosts ?? 3).map((id, i) => ({ id, hostname: `rbx-${i}.example.com` })),
    defs,
    values: opts.secret ? { TOKEN: opts.secret } : {},
    triggeredBy: "user",
    requestedById: null,
    status: opts.status ?? "queued",
    dryRun: opts.dryRun ?? false,
  });
  return runId;
}

async function claimAndRun(runOnHost: RunOnHost, extra: Record<string, unknown> = {}) {
  const id = await claimNextRun(HOLDER);
  expect(id).not.toBeNull();
  const status = await executeRun(id!, { holder: HOLDER, runOnHost, globalLimit: pLimit(50), ...FAST, ...extra });
  return { id: id!, status };
}

const ok: RunOnHost = async (_run, _serverId, deps) => {
  deps.onStdout("done\n");
  return { status: "succeeded", exitCode: 0 };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("claiming", () => {
  it("gives a queued run to exactly one of two racing holders", async () => {
    const runId = await makeRun({});
    const [a, b] = await Promise.all([claimNextRun("holder-1"), claimNextRun("holder-2")]);
    expect([a, b].filter((x) => x !== null)).toEqual([runId]);
    const run = await prisma.runbookRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("running");
    expect(["holder-1", "holder-2"]).toContain(run.claimedBy);
  });

  it("does not claim runs waiting for approval", async () => {
    await makeRun({ status: "pending_approval" });
    expect(await claimNextRun(HOLDER)).toBeNull();
  });

  it("refuses to execute a run another holder claimed", async () => {
    await makeRun({});
    const id = await claimNextRun("someone-else");
    expect(await executeRun(id!, { holder: HOLDER, runOnHost: ok, ...FAST })).toBeNull();
  });
});

describe("executeRun", () => {
  it("runs every host, stores output, and resolves the runbook incident", async () => {
    await makeRun({});
    const { id, status } = await claimAndRun(ok);
    expect(status).toBe("succeeded");
    const hosts = await prisma.runbookHostResult.findMany({ where: { runId: id } });
    expect(hosts.map((h) => h.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(hosts.every((h) => h.stdout === "done\n")).toBe(true);
    const run = await prisma.runbookRun.findUniqueOrThrow({ where: { id } });
    expect(run.summary).toMatchObject({ total: 3, succeeded: 3 });
    expect(emitted.map((e) => [e.type, e.action, e.dedupKey])).toEqual([
      ["runbook_succeeded", "resolve", `rackmap:runbook:${runbookId}`],
    ]);
  });

  it("hands the prelude and script to the transport, and masks secrets in stored output", async () => {
    const seen: string[] = [];
    const leaky: RunOnHost = async (_run, _serverId, deps) => {
      seen.push(deps.script);
      // The secret, split across chunks and streams.
      deps.onStdout("token=sup3r");
      deps.onStdout("-s3cret!\n");
      deps.onStderr("again: sup3r-s3cret!");
      return { status: "succeeded", exitCode: 0 };
    };
    const runId = await makeRun({ hosts: 1, secret: "sup3r-s3cret!" });
    const { status } = await claimAndRun(leaky);
    expect(status).toBe("succeeded");
    expect(seen[0]).toContain("export TOKEN='sup3r-s3cret!'");
    expect(seen[0]).toContain(`export RACKMAP_RUN_ID='${runId}'`);
    expect(seen[0]!.endsWith("echo hi\n")).toBe(true);
    const [host] = await prisma.runbookHostResult.findMany({ where: { runId } });
    expect(host!.stdout).toBe("token=***\n");
    expect(host!.stderr).toBe("again: ***");
    const run = await prisma.runbookRun.findUniqueOrThrow({ where: { id: runId } });
    expect(JSON.stringify(run.params)).not.toContain("sup3r");
    expect(run.paramsEnc!.startsWith("v3.")).toBe(true);
  });

  it("respects the run's concurrency", async () => {
    let inFlight = 0;
    let max = 0;
    const slow: RunOnHost = async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await sleep(40);
      inFlight--;
      return { status: "succeeded", exitCode: 0 };
    };
    await makeRun({ hosts: 6, concurrency: 2 });
    const { status } = await claimAndRun(slow);
    expect(status).toBe("succeeded");
    expect(max).toBe(2);
  });

  it("respects the global SSH session limit across runs", async () => {
    let inFlight = 0;
    let max = 0;
    const slow: RunOnHost = async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await sleep(30);
      inFlight--;
      return { status: "succeeded", exitCode: 0 };
    };
    await makeRun({ hosts: 4, concurrency: 4 });
    await makeRun({ hosts: 4, concurrency: 4 });
    const global = pLimit(3);
    const a = await claimNextRun(HOLDER);
    const b = await claimNextRun(HOLDER);
    await Promise.all([a, b].map((id) => executeRun(id!, { holder: HOLDER, runOnHost: slow, globalLimit: global, ...FAST })));
    expect(max).toBe(3);
  });

  it("stops launching hosts once maxFailures is reached", async () => {
    let calls = 0;
    const failing: RunOnHost = async () => {
      calls++;
      return { status: "failed", exitCode: 1, errorCode: "NONZERO_EXIT" };
    };
    await makeRun({ hosts: 5, concurrency: 1, maxFailures: 2 });
    const { id, status } = await claimAndRun(failing);
    expect(status).toBe("failed");
    expect(calls).toBe(2);
    const hosts = await prisma.runbookHostResult.findMany({ where: { runId: id }, orderBy: { id: "asc" } });
    expect(hosts.map((h) => h.status)).toEqual(["failed", "failed", "skipped", "skipped", "skipped"]);
    const run = await prisma.runbookRun.findUniqueOrThrow({ where: { id } });
    expect(run.error).toMatch(/maxFailures 2/);
    expect(emitted.map((e) => e.type)).toEqual(["runbook_failed"]);
    expect(emitted[0]!.action).toBe("trigger");
  });

  it("marks a mixed outcome partially_failed", async () => {
    let n = 0;
    const mixed: RunOnHost = async () => (n++ === 0 ? { status: "failed", exitCode: 3, errorCode: "NONZERO_EXIT" } : { status: "succeeded", exitCode: 0 });
    await makeRun({ hosts: 3, concurrency: 1 });
    const { id, status } = await claimAndRun(mixed);
    expect(status).toBe("partially_failed");
    const failedHost = await prisma.runbookHostResult.findFirst({ where: { runId: id, status: "failed" } });
    expect(failedHost?.exitCode).toBe(3);
  });

  it("cancels mid-run: the running host is aborted and the rest never start", async () => {
    let started = 0;
    const waitForAbort: RunOnHost = async (_run, _serverId, deps) => {
      started++;
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) return resolve();
        deps.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 5_000);
      });
      return deps.signal.aborted ? { status: "cancelled", errorCode: "CANCELLED" } : { status: "succeeded", exitCode: 0 };
    };
    const runId = await makeRun({ hosts: 4, concurrency: 1 });
    const id = await claimNextRun(HOLDER);
    const done = executeRun(id!, { holder: HOLDER, runOnHost: waitForAbort, globalLimit: pLimit(50), ...FAST });
    while (started === 0) await sleep(10);
    await prisma.runbookRun.update({ where: { id: runId }, data: { cancelRequestedAt: new Date() } });
    expect(await done).toBe("cancelled");
    expect(started).toBe(1);
    const hosts = await prisma.runbookHostResult.findMany({ where: { runId } });
    expect(hosts.every((h) => h.status === "cancelled")).toBe(true);
    expect(emitted).toEqual([]);
  });

  it("caps stored output and replaces NUL bytes", async () => {
    const noisy: RunOnHost = async (_run, _serverId, deps) => {
      deps.onStdout("a\u0000b\n");
      for (let i = 0; i < 50; i++) deps.onStdout("x".repeat(100));
      return { status: "succeeded", exitCode: 0 };
    };
    await makeRun({ hosts: 1 });
    const { id } = await claimAndRun(noisy, { maxOutputBytes: 1024 });
    const [host] = await prisma.runbookHostResult.findMany({ where: { runId: id } });
    expect(Buffer.byteLength(host!.stdout)).toBeLessThanOrEqual(1024);
    expect(host!.stdout.startsWith("a�b\n")).toBe(true);
    expect(host!.stdoutTruncated).toBe(true);
  });

  it("records a transport crash as EXEC_FAILED without failing the other hosts", async () => {
    let n = 0;
    const flaky: RunOnHost = async () => {
      if (n++ === 0) throw new Error("channel exploded");
      return { status: "succeeded", exitCode: 0 };
    };
    await makeRun({ hosts: 2, concurrency: 1 });
    const { id, status } = await claimAndRun(flaky);
    expect(status).toBe("partially_failed");
    const bad = await prisma.runbookHostResult.findFirstOrThrow({ where: { runId: id, status: "failed" } });
    expect(bad.errorCode).toBe("EXEC_FAILED");
    expect(bad.stderr).toContain("rackmap: channel exploded");
  });

  it("dry runs send the probe, not the script, and raise no alerts", async () => {
    const scripts: string[] = [];
    const probe: RunOnHost = async (_run, _serverId, deps) => {
      scripts.push(deps.script);
      expect(deps.asRoot).toBe(false);
      return { status: "failed", exitCode: 255, errorCode: "UNREACHABLE" };
    };
    await makeRun({ hosts: 1, dryRun: true });
    const { status } = await claimAndRun(probe);
    expect(status).toBe("failed");
    expect(scripts[0]).toContain("sudo -n true");
    expect(scripts[0]).not.toContain("echo hi");
    expect(emitted).toEqual([]);
  });
});

describe("vault locked", () => {
  it("maps connection and sudo failures to VAULT_LOCKED", () => {
    expect(mapConnectError(new SshError("vault_locked", "locked")).errorCode).toBe("VAULT_LOCKED");
    expect(mapConnectError(new SshError("no_credentials", "none")).errorCode).toBe("NO_CREDENTIALS");
    expect(mapConnectError(new SshError("host_key_changed", "x")).errorCode).toBe("HOST_KEY_CHANGED");
    const sudoFail = {
      exitCode: 1,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
      durationMs: 5,
      errorCode: "SUDO_PASSWORD_REQUIRED" as const,
    };
    expect(mapExecResult(sudoFail, { passwordUnavailable: "vault_locked" }).errorCode).toBe("VAULT_LOCKED");
    expect(mapExecResult(sudoFail, {}).errorCode).toBe("SUDO_PASSWORD_REQUIRED");
    expect(mapExecResult({ ...sudoFail, errorCode: undefined, exitCode: 2 }).errorCode).toBe("NONZERO_EXIT");
    expect(mapExecResult({ ...sudoFail, errorCode: undefined, timedOut: true, exitCode: 124 }).status).toBe("timed_out");
  });

  it("emits one system event per runbook per day", async () => {
    const locked: RunOnHost = async (): Promise<HostOutcome> => ({ status: "failed", errorCode: "VAULT_LOCKED", message: "vault locked" });
    await makeRun({ hosts: 2 });
    await claimAndRun(locked);
    await makeRun({ hosts: 2 });
    await claimAndRun(locked);
    const system = emitted.filter((e) => e.type === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.dedupKey).toBe(`rackmap:runbook-vault:${runbookId}`);
    const hosts = await prisma.runbookHostResult.findMany({ where: { run: { runbookId } } });
    expect(hosts.every((h) => h.errorCode === "VAULT_LOCKED")).toBe(true);
  });
});

describe("reaper", () => {
  it("fails runs whose executor stopped heartbeating", async () => {
    const runId = await makeRun({ hosts: 3 });
    await claimNextRun("dead-replica");
    const hosts = await prisma.runbookHostResult.findMany({ where: { runId }, orderBy: { id: "asc" } });
    await prisma.runbookHostResult.update({ where: { id: hosts[0]!.id }, data: { status: "running" } });
    await prisma.runbookRun.update({ where: { id: runId }, data: { heartbeatAt: new Date(Date.now() - 5 * 60_000) } });

    const result = await reapRunbookRuns(new Date());
    expect(result.lost).toBe(1);
    const run = await prisma.runbookRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/may still be running/);
    const after = await prisma.runbookHostResult.findMany({ where: { runId }, orderBy: { id: "asc" } });
    expect(after.map((h) => [h.status, h.errorCode])).toEqual([
      ["failed", "EXECUTOR_LOST"],
      ["skipped", "EXECUTOR_LOST"],
      ["skipped", "EXECUTOR_LOST"],
    ]);
    expect(emitted.map((e) => e.type)).toContain("runbook_failed");
  });

  it("leaves live runs alone and expires stale approvals", async () => {
    const live = await makeRun({ hosts: 1 });
    await claimNextRun(HOLDER);
    const pending = await makeRun({ hosts: 1, status: "pending_approval" });
    await prisma.runbookRun.update({ where: { id: pending }, data: { createdAt: new Date(Date.now() - 48 * 3600_000) } });

    const result = await reapRunbookRuns(new Date(), { approvalTtlMs: 24 * 3600_000 });
    expect(result).toEqual({ lost: 0, expired: 1 });
    expect((await prisma.runbookRun.findUniqueOrThrow({ where: { id: live } })).status).toBe("running");
    expect((await prisma.runbookRun.findUniqueOrThrow({ where: { id: pending } })).status).toBe("expired");
  });

  it("a replica shutting down fails only its own runs", async () => {
    const mine = await makeRun({ hosts: 1 });
    await claimNextRun(HOLDER);
    const theirs = await makeRun({ hosts: 1 });
    await claimNextRun("other-replica");
    expect(await markOwnRunsFailed(HOLDER, "shutdown")).toBe(1);
    expect((await prisma.runbookRun.findUniqueOrThrow({ where: { id: mine } })).error).toBe("shutdown");
    expect((await prisma.runbookRun.findUniqueOrThrow({ where: { id: theirs } })).status).toBe("running");
  });
});

describe("scheduler", () => {
  let scheduled = 0;

  beforeAll(async () => {
    await prisma.systemLicense.upsert({
      where: { id: 1 },
      create: { id: 1, key: "TEST-PRO-LICENSE-KEY", tier: "pro", maxServers: -1 },
      update: { key: "TEST-PRO-LICENSE-KEY", tier: "pro", maxServers: -1, expiresAt: null },
    });
    scheduled = (
      await prisma.runbook.create({
        data: {
          name: "rbx-scheduled",
          script: "uptime",
          targetSelector: { serverIds: serverIds.slice(0, 2) },
          schedule: "*/5 * * * *",
          scheduleEnabled: true,
        },
      })
    ).id;
  });

  afterEach(async () => {
    await prisma.runbookRun.deleteMany({ where: { runbookId: scheduled } });
  });

  it("creates one run per due occurrence and advances nextScheduledAt", async () => {
    const now = new Date("2026-09-25T10:02:00Z");
    await prisma.runbook.update({ where: { id: scheduled }, data: { nextScheduledAt: new Date("2026-09-25T10:00:00Z") } });

    const first = await runRunbookScheduleTick(now);
    expect(first.created).toHaveLength(1);
    const again = await runRunbookScheduleTick(now);
    expect(again.created).toHaveLength(0);

    const rb = await prisma.runbook.findUniqueOrThrow({ where: { id: scheduled } });
    expect(rb.nextScheduledAt?.toISOString()).toBe("2026-09-25T10:05:00.000Z");
    const run = await prisma.runbookRun.findUniqueOrThrow({ where: { id: first.created[0]! } });
    expect(run.triggeredBy).toBe("schedule");
    expect(run.status).toBe("queued");
    expect(run.targetServerIds).toEqual(serverIds.slice(0, 2));
  });

  it("skips an occurrence while the previous run is still active", async () => {
    await prisma.runbook.update({ where: { id: scheduled }, data: { nextScheduledAt: new Date("2026-09-25T10:00:00Z") } });
    await runRunbookScheduleTick(new Date("2026-09-25T10:00:30Z"));
    await prisma.runbook.update({ where: { id: scheduled }, data: { nextScheduledAt: new Date("2026-09-25T10:05:00Z") } });
    const second = await runRunbookScheduleTick(new Date("2026-09-25T10:05:30Z"));
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toEqual([{ runbookId: scheduled, reason: "overlap" }]);
  });

  it("skips occurrences missed by more than one period", async () => {
    await prisma.runbook.update({ where: { id: scheduled }, data: { nextScheduledAt: new Date("2026-09-24T10:00:00Z") } });
    const result = await runRunbookScheduleTick(new Date("2026-09-25T10:02:00Z"));
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual([{ runbookId: scheduled, reason: "missed" }]);
    const rb = await prisma.runbook.findUniqueOrThrow({ where: { id: scheduled } });
    expect(rb.nextScheduledAt?.toISOString()).toBe("2026-09-25T10:05:00.000Z");
  });

  it("does not run without a runbooks license", async () => {
    await prisma.systemLicense.update({ where: { id: 1 }, data: { tier: "free", key: null } });
    try {
      await prisma.runbook.update({ where: { id: scheduled }, data: { nextScheduledAt: new Date("2026-09-25T10:00:00Z") } });
      const result = await runRunbookScheduleTick(new Date("2026-09-25T10:01:00Z"));
      expect(result.skipped).toEqual([{ runbookId: scheduled, reason: "license" }]);
    } finally {
      await prisma.systemLicense.update({ where: { id: 1 }, data: { tier: "pro", key: "TEST-PRO-LICENSE-KEY" } });
    }
  });
});
