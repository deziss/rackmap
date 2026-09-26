import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

// The alert outbox is another agent's module; stand in with the contract's minimum
// (one AlertEvent row per call) so these assertions do not depend on it.
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
        serverId: (e["serverId"] as number) ?? null,
      },
    });
    return { eventId: ev.id, queued: 0 };
  }),
}));

const { createApp } = await import("../app.js");
const { prisma } = await import("../db.js");
const { loginAs } = await import("./helpers.js");
const { resetRateLimits } = await import("../middleware/rate-limit.js");
const { generateHeartbeatToken } = await import("../services/heartbeat.service.js");
const { recordHeartbeatPing } = await import("../services/heartbeat-ping.service.js");

/**
 * The ping endpoint is the one unauthenticated write path in the API. It must
 * treat the token as the whole credential (404 for anything unknown, whatever
 * else the request carries), never page twice for the same failure, and never
 * turn a long job log into a "down".
 */

const app = createApp();
let editorCookie = "";
let viewerCookie = "";
const created: number[] = [];

beforeAll(async () => {
  [editorCookie, viewerCookie] = await Promise.all([loginAs(app, "editor"), loginAs(app, "viewer")]);
});

beforeEach(() => resetRateLimits());

afterEach(async () => {
  if (created.length) {
    await prisma.alertEvent.deleteMany({ where: { heartbeatId: { in: created } } });
    await prisma.heartbeat.deleteMany({ where: { id: { in: created } } });
    created.length = 0;
  }
});

async function makeHeartbeat(data: Record<string, unknown> = {}) {
  const tok = generateHeartbeatToken();
  const hb = await prisma.heartbeat.create({
    data: {
      name: "ping-test",
      kind: "cron",
      schedule: "*/5 * * * *",
      timezone: "UTC",
      tokenHash: tok.tokenHash,
      tokenEnc: tok.tokenEnc,
      tokenPrefix: tok.tokenPrefix,
      ...data,
    },
  });
  created.push(hb.id);
  return { id: hb.id, token: tok.token };
}

function ping(path: string, init: RequestInit = {}) {
  return app.request(`/api/v1/ping/${path}`, init);
}

const events = (heartbeatId: number) => prisma.alertEvent.findMany({ where: { heartbeatId }, orderBy: { id: "asc" } });

describe("GET/POST /api/v1/ping/:token", () => {
  it("answers 404 — not 401 — for an unknown token, with or without credentials", async () => {
    const unknown = randomBytes(32).toString("base64url");
    const bare = await ping(unknown);
    expect(bare.status).toBe(404);
    expect(await bare.text()).toBe("Not found");
    const withKey = await ping(unknown, { headers: { Authorization: "Bearer sk_bogus" } });
    expect(withKey.status).toBe(404);
  });

  it("accepts a valid ping even with a bogus API key attached (mounted before apiKeyAuth)", async () => {
    const { id, token } = await makeHeartbeat();
    const res = await ping(token, { headers: { Authorization: "Bearer sk_bogus" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const hb = await prisma.heartbeat.findUniqueOrThrow({ where: { id } });
    expect(hb.status).toBe("up");
    expect(hb.expectedAt).not.toBeNull();
    expect(hb.alertAt).not.toBeNull();
  });

  it("serves HEAD like GET", async () => {
    const { id, token } = await makeHeartbeat();
    const res = await ping(token, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await prisma.heartbeatPing.count({ where: { heartbeatId: id } })).toBe(1);
  });

  it("rc=1 marks it down with exactly one alert; repeats do not re-alert; success recovers", async () => {
    const { id, token } = await makeHeartbeat({ status: "up" });
    expect((await ping(`${token}/1`, { method: "POST", body: "disk full" })).status).toBe(200);
    let hb = await prisma.heartbeat.findUniqueOrThrow({ where: { id } });
    expect(hb.status).toBe("down");
    expect(hb.lastExitCode).toBe(1);
    let evs = await events(id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe("heartbeat_fail");
    expect(evs[0]!.action).toBe("trigger");
    expect(evs[0]!.dedupKey).toBe(`rackmap:heartbeat:${id}`);
    expect((evs[0]!.payload as Record<string, unknown>)["reason"]).toBe("exit_code");
    expect((evs[0]!.payload as Record<string, unknown>)["bodySnippet"]).toBe("disk full");

    // Same failure again, and via ?rc= and /fail: recorded, not re-alerted.
    await ping(`${token}/2`);
    await ping(`${token}?rc=4`);
    await ping(`${token}/fail`);
    expect(await events(id)).toHaveLength(1);
    expect(await prisma.heartbeatPing.count({ where: { heartbeatId: id, kind: "fail" } })).toBe(4);

    await ping(`${token}/0`);
    hb = await prisma.heartbeat.findUniqueOrThrow({ where: { id } });
    expect(hb.status).toBe("up");
    evs = await events(id);
    expect(evs.map((e) => e.type)).toEqual(["heartbeat_fail", "heartbeat_recover"]);
    expect(evs[1]!.action).toBe("resolve");
    expect(evs[1]!.dedupKey).toBe(`rackmap:heartbeat:${id}`);
  });

  it("rejects an out-of-range exit code", async () => {
    const { token } = await makeHeartbeat();
    expect((await ping(`${token}?rc=300`)).status).toBe(400);
    expect((await ping(`${token}?rc=abc`)).status).toBe(400);
  });

  it("/start then success records the run's duration", async () => {
    const { id, token } = await makeHeartbeat();
    expect((await ping(`${token}/start`)).status).toBe(200);
    expect((await ping(`${token}/0`)).status).toBe(200);
    const last = await prisma.heartbeatPing.findFirstOrThrow({ where: { heartbeatId: id, kind: "success" } });
    expect(last.durationMs).not.toBeNull();
    expect(last.durationMs!).toBeGreaterThanOrEqual(0);

    // Exact arithmetic with a fixed clock, on a heartbeat with no history.
    const { id: fixedId, token: fixedToken } = await makeHeartbeat();
    const t0 = new Date("2026-02-01T03:00:00Z");
    await recordHeartbeatPing({ token: fixedToken, kind: "start", exitCode: null, body: null, bodyTruncated: false, remoteIp: null, userAgent: null, now: t0 });
    const out = await recordHeartbeatPing({
      token: fixedToken,
      kind: "success",
      exitCode: 0,
      body: null,
      bodyTruncated: false,
      remoteIp: null,
      userAgent: null,
      now: new Date(t0.getTime() + 1500),
    });
    expect(out?.durationMs).toBe(1500);
    const hb = await prisma.heartbeat.findUniqueOrThrow({ where: { id: fixedId } });
    expect(hb.lastDurationMs).toBe(1500);
    // A success with no start in front of it has no duration.
    const lone = await recordHeartbeatPing({ token: fixedToken, kind: "success", exitCode: 0, body: null, bodyTruncated: false, remoteIp: null, userAgent: null, now: new Date(t0.getTime() + 5000) });
    expect(lone?.durationMs).toBeNull();
  });

  it("keeps the first 10 KB of a large body instead of refusing it", async () => {
    const { id, token } = await makeHeartbeat();
    const body = "x".repeat(25_000);
    const res = await ping(token, { method: "POST", body, headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(200);
    const p = await prisma.heartbeatPing.findFirstOrThrow({ where: { heartbeatId: id } });
    expect(p.body).toHaveLength(10_240);
    expect(p.bodyTruncated).toBe(true);

    const small = await ping(`${token}/log`, { method: "POST", body: "note\u0000with nul" });
    expect(small.status).toBe(200);
    const note = await prisma.heartbeatPing.findFirstOrThrow({ where: { heartbeatId: id, kind: "log" } });
    expect(note.body).toBe("notewith nul");
    expect(note.bodyTruncated).toBe(false);
  });

  it("a log ping never changes status", async () => {
    const { id, token } = await makeHeartbeat({ status: "down" });
    await ping(`${token}/log`, { method: "POST", body: "still broken" });
    const hb = await prisma.heartbeat.findUniqueOrThrow({ where: { id } });
    expect(hb.status).toBe("down");
    expect(hb.lastPingKind).toBe("log");
    expect(await events(id)).toHaveLength(0);
  });

  it("rate-limits per token with 429", async () => {
    const token = randomBytes(32).toString("base64url");
    for (let i = 0; i < 120; i++) {
      const r = await ping(token);
      expect(r.status).toBe(404);
    }
    const limited = await ping(token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Another token from the same peer is unaffected.
    expect((await ping(randomBytes(32).toString("base64url"))).status).toBe(404);
  });

  it("a paused heartbeat resumes on ping (resumeOnPing), otherwise stays paused", async () => {
    const r = await app.request("/api/v1/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: editorCookie },
      body: JSON.stringify({ name: "paused-job", kind: "period", periodSeconds: 3600 }),
    });
    expect(r.status).toBe(201);
    const { heartbeat, token } = (await r.json()) as { heartbeat: { id: number }; token: string };
    created.push(heartbeat.id);
    const pause = await app.request(`/api/v1/heartbeats/${heartbeat.id}/pause`, { method: "POST", headers: { Cookie: editorCookie } });
    expect(pause.status).toBe(200);

    await ping(token);
    let hb = await prisma.heartbeat.findUniqueOrThrow({ where: { id: heartbeat.id } });
    expect(hb.status).toBe("up");

    const stay = await makeHeartbeat({ status: "paused", resumeOnPing: false });
    await ping(`${stay.token}/1`);
    hb = await prisma.heartbeat.findUniqueOrThrow({ where: { id: stay.id } });
    expect(hb.status).toBe("paused");
    expect(hb.lastFailureAt).not.toBeNull();
    expect(await events(stay.id)).toHaveLength(0);
  });

  it("shows job output to editors only", async () => {
    const { id, token } = await makeHeartbeat();
    await ping(token, { method: "POST", body: "secret-ish output" });
    const asEditor = (await (await app.request(`/api/v1/heartbeats/${id}`, { headers: { Cookie: editorCookie } })).json()) as {
      pings: { body: string | null }[];
      token: string | null;
    };
    expect(asEditor.pings[0]!.body).toBe("secret-ish output");
    expect(asEditor.token).toBe(token);
    const asViewer = (await (await app.request(`/api/v1/heartbeats/${id}`, { headers: { Cookie: viewerCookie } })).json()) as {
      pings: { body: string | null }[];
      token: string | null;
      pingUrl: string | null;
    };
    expect(asViewer.pings[0]!.body).toBeNull();
    expect(asViewer.token).toBeNull();
    expect(asViewer.pingUrl).toBeNull();
    const list = (await (await app.request(`/api/v1/heartbeats/${id}/pings`, { headers: { Cookie: viewerCookie } })).json()) as {
      items: { body: string | null }[];
    };
    expect(list.items[0]!.body).toBeNull();
  });

  it("never returns token material in DTOs", async () => {
    const { id } = await makeHeartbeat();
    const res = await app.request("/api/v1/heartbeats", { headers: { Cookie: viewerCookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("tokenHash");
    expect(text).not.toContain("tokenEnc");
    const body = JSON.parse(text) as { items: { id: number }[] };
    expect(body.items.some((h) => h.id === id)).toBe(true);
  });
});
