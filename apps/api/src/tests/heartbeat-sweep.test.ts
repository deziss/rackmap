import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../services/alerting/emit.js", () => ({
  emitAlert: vi.fn(async (e: Record<string, unknown>) => {
    const { prisma } = await import("../db.js");
    const ev = await prisma.alertEvent.create({
      data: {
        type: e["type"] as string,
        severity: e["severity"] as string,
        action: (e["action"] as string) ?? "info",
        dedupKey: (e["dedupKey"] as string) ?? null,
        title: e["title"] as string,
        summary: e["summary"] as string,
        payload: (e["payload"] ?? {}) as object,
        heartbeatId: (e["heartbeatId"] as number) ?? null,
      },
    });
    return { eventId: ev.id, queued: 0 };
  }),
}));

const { prisma } = await import("../db.js");
const { env } = await import("../env.js");
const {
  applySweepTransition,
  findSweepCandidates,
  generateHeartbeatToken,
  pruneHeartbeatPings,
  runHeartbeatSweep,
  runHeartbeatSweepLocked,
} = await import("../services/heartbeat.service.js");
const { recordHeartbeatPing } = await import("../services/heartbeat-ping.service.js");

/**
 * The sweep is what pages people at 3 a.m. It must alert on the edge only, lose
 * every race against a ping that proves the job is fine, and alert once no matter
 * how many replicas run it.
 */

const created: number[] = [];
const servers: number[] = [];

afterEach(async () => {
  await prisma.alertEvent.deleteMany({ where: { heartbeatId: { in: created } } });
  await prisma.heartbeat.deleteMany({ where: { id: { in: created } } });
  await prisma.server.deleteMany({ where: { id: { in: servers } } });
  created.length = 0;
  servers.length = 0;
});

const T = new Date("2026-04-01T10:00:00Z");
const plus = (s: number) => new Date(T.getTime() + s * 1000);

async function makeHeartbeat(data: Record<string, unknown> = {}) {
  const tok = generateHeartbeatToken();
  const hb = await prisma.heartbeat.create({
    data: {
      name: "sweep-test",
      kind: "period",
      periodSeconds: 3600,
      graceSeconds: 300,
      tokenHash: tok.tokenHash,
      tokenEnc: tok.tokenEnc,
      tokenPrefix: tok.tokenPrefix,
      status: "up",
      lastPingAt: plus(-3600),
      lastSuccessAt: plus(-3600),
      expectedAt: T,
      alertAt: plus(300),
      ...data,
    },
  });
  created.push(hb.id);
  return { id: hb.id, token: tok.token };
}

const events = (heartbeatId: number) => prisma.alertEvent.findMany({ where: { heartbeatId }, orderBy: { id: "asc" } });
const statusOf = async (id: number) => (await prisma.heartbeat.findUniqueOrThrow({ where: { id } })).status;

describe("runHeartbeatSweep", () => {
  it("up → late → down, alerting once per edge", async () => {
    const { id } = await makeHeartbeat({ notifyOnLate: true });

    await runHeartbeatSweep(plus(-1));
    expect(await statusOf(id)).toBe("up");

    await runHeartbeatSweep(plus(10));
    expect(await statusOf(id)).toBe("late");
    await runHeartbeatSweep(plus(20));
    expect((await events(id)).map((e) => e.type)).toEqual(["heartbeat_late"]);

    await runHeartbeatSweep(plus(301));
    expect(await statusOf(id)).toBe("down");
    await runHeartbeatSweep(plus(400));
    const evs = await events(id);
    expect(evs.map((e) => e.type)).toEqual(["heartbeat_late", "heartbeat_fail"]);
    expect((evs[1]!.payload as Record<string, unknown>)["reason"]).toBe("missed");
    expect(evs[1]!.dedupKey).toBe(`rackmap:heartbeat:${id}`);
  });

  it("stays quiet about lateness unless notifyOnLate is set", async () => {
    const { id } = await makeHeartbeat();
    await runHeartbeatSweep(plus(10));
    expect(await statusOf(id)).toBe("late");
    expect(await events(id)).toHaveLength(0);
  });

  it("goes straight to down (no late alert) when already past the deadline", async () => {
    const { id } = await makeHeartbeat({ notifyOnLate: true });
    await runHeartbeatSweep(plus(600));
    expect(await statusOf(id)).toBe("down");
    expect((await events(id)).map((e) => e.type)).toEqual(["heartbeat_fail"]);
  });

  it("names the reason: never pinged, runtime exceeded", async () => {
    const never = await makeHeartbeat({ status: "new", lastPingAt: null, lastSuccessAt: null });
    const running = await makeHeartbeat({ status: "up", lastStartAt: plus(-60), lastSuccessAt: plus(-3600) });
    await runHeartbeatSweep(plus(301));
    const reason = async (id: number) => ((await events(id))[0]!.payload as Record<string, unknown>)["reason"];
    expect(await reason(never.id)).toBe("never_pinged");
    expect(await reason(running.id)).toBe("runtime_exceeded");
  });

  it("ignores paused and down heartbeats, and ones on a deleted server", async () => {
    const server = await prisma.server.create({
      data: { hostname: "hb-sweep-deleted.test", ip: "192.0.2.50", username: "root", deletedAt: plus(-10) },
    });
    servers.push(server.id);
    const paused = await makeHeartbeat({ status: "paused" });
    const down = await makeHeartbeat({ status: "down" });
    const orphan = await makeHeartbeat({ serverId: server.id });
    await runHeartbeatSweep(plus(1000));
    expect(await statusOf(paused.id)).toBe("paused");
    expect(await statusOf(down.id)).toBe("down");
    expect(await statusOf(orphan.id)).toBe("up");
    for (const h of [paused, down, orphan]) expect(await events(h.id)).toHaveLength(0);
  });

  it("a ping that lands while the sweep is deciding wins — no false alert", async () => {
    const { id, token } = await makeHeartbeat();
    const now = plus(301);
    const candidates = (await findSweepCandidates(now)).filter((c) => c.id === id);
    expect(candidates).toHaveLength(1);

    // The job checks in between the sweep's read and its write.
    await recordHeartbeatPing({ token, kind: "success", exitCode: 0, body: null, bodyTruncated: false, remoteIp: null, userAgent: null, now });

    expect(await applySweepTransition(candidates[0]!)).toBe(false);
    expect(await statusOf(id)).toBe("up");
    expect(await events(id)).toHaveLength(0);
  });

  it("two replicas sweeping at once produce one transition and one alert", async () => {
    const { id } = await makeHeartbeat();
    const now = plus(301);
    const results = await Promise.all([runHeartbeatSweep(now), runHeartbeatSweep(now), runHeartbeatSweep(now)]);
    expect(results.reduce((n, r) => n + r.down, 0)).toBe(1);
    expect(await events(id)).toHaveLength(1);
  });

  it("under the job lease, two holders still transition once", async () => {
    const { id } = await makeHeartbeat();
    await prisma.schedulerLock.deleteMany({ where: { name: "heartbeat:sweep" } });
    const now = plus(301);
    await Promise.all([runHeartbeatSweepLocked(now, "replica-a"), runHeartbeatSweepLocked(now, "replica-b")]);
    expect(await statusOf(id)).toBe("down");
    expect(await events(id)).toHaveLength(1);
  });
});

describe("pruneHeartbeatPings", () => {
  it("keeps the newest N per heartbeat and drops anything past retention", async () => {
    const keepBefore = env.HEARTBEAT_PING_KEEP;
    env.HEARTBEAT_PING_KEEP = 10;
    try {
      const busy = await makeHeartbeat();
      const quiet = await makeHeartbeat();
      const now = new Date();
      await prisma.heartbeatPing.createMany({
        data: Array.from({ length: 15 }, (_, i) => ({
          heartbeatId: busy.id,
          kind: "success",
          createdAt: new Date(now.getTime() - (15 - i) * 60_000),
        })),
      });
      await prisma.heartbeatPing.createMany({
        data: [
          { heartbeatId: quiet.id, kind: "success", createdAt: new Date(now.getTime() - 60_000) },
          { heartbeatId: quiet.id, kind: "success", createdAt: new Date(now.getTime() - (env.HEARTBEAT_PING_RETENTION_DAYS + 1) * 86_400_000) },
        ],
      });

      await pruneHeartbeatPings(now);

      const left = await prisma.heartbeatPing.findMany({ where: { heartbeatId: busy.id }, orderBy: { createdAt: "asc" } });
      expect(left).toHaveLength(10);
      // The five oldest went.
      expect(left[0]!.createdAt.getTime()).toBe(now.getTime() - 10 * 60_000);
      expect(await prisma.heartbeatPing.count({ where: { heartbeatId: quiet.id } })).toBe(1);
    } finally {
      env.HEARTBEAT_PING_KEEP = keepBefore;
    }
  });

  it("breaks createdAt ties by id, and leaves heartbeats within the limit alone", async () => {
    const keepBefore = env.HEARTBEAT_PING_KEEP;
    env.HEARTBEAT_PING_KEEP = 10;
    try {
      const tied = await makeHeartbeat();
      const within = await makeHeartbeat();
      const now = new Date();
      const at = new Date(now.getTime() - 60_000);
      await prisma.heartbeatPing.createMany({ data: Array.from({ length: 13 }, () => ({ heartbeatId: tied.id, kind: "success", createdAt: at })) });
      await prisma.heartbeatPing.createMany({ data: Array.from({ length: 10 }, () => ({ heartbeatId: within.id, kind: "success", createdAt: at })) });
      const ids = (await prisma.heartbeatPing.findMany({ where: { heartbeatId: tied.id }, orderBy: { id: "desc" }, select: { id: true } })).map((p) => p.id);

      const res = await pruneHeartbeatPings(now);

      expect(res.overflow).toBeGreaterThanOrEqual(3);
      const left = (await prisma.heartbeatPing.findMany({ where: { heartbeatId: tied.id }, orderBy: { id: "desc" }, select: { id: true } })).map((p) => p.id);
      // Same instant for all: the three lowest ids went.
      expect(left).toEqual(ids.slice(0, 10));
      expect(await prisma.heartbeatPing.count({ where: { heartbeatId: within.id } })).toBe(10);
    } finally {
      env.HEARTBEAT_PING_KEEP = keepBefore;
    }
  });
});
