import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * Authorization guards for the drift routes. The SSH layer is a spy that fails
 * loudly, so a request that gets past the guards and reaches a host is visible.
 */

const mocks = vi.hoisted(() => ({ connectToServer: vi.fn(), execPreferRoot: vi.fn() }));
vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});
vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execPreferRoot: mocks.execPreferRoot };
});
// The license gate is not under test here.
vi.mock("../services/license.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/license.service.js")>()),
  assertFeatureEnabled: vi.fn(async () => {}),
}));

const { createApp } = await import("../app.js");
const { loginAs } = await import("./helpers.js");
const { prisma } = await import("../db.js");
const { SshError } = await import("../services/ssh.service.js");

const app = createApp();

let viewerCookie = "";
let editorCookie = "";
let adminCookie = "";
let serverId = 0;

beforeAll(async () => {
  viewerCookie = await loginAs(app, "viewer");
  editorCookie = await loginAs(app, "editor");
  adminCookie = await loginAs(app, "admin");
  const s = await prisma.server.create({ data: { hostname: "drift-guards.example.com", ip: "192.0.2.71", username: "ops" } });
  serverId = s.id;
});

beforeEach(() => {
  mocks.connectToServer.mockReset().mockRejectedValue(new Error("SSH must not be reached in this test"));
  mocks.execPreferRoot.mockReset().mockRejectedValue(new Error("the host must not be reached in this test"));
});

type Case = { name: string; method: string; path: () => string };

const ROUTES: Case[] = [
  { name: "GET /servers/:id/drift", method: "GET", path: () => `/api/v1/servers/${serverId}/drift` },
  { name: "POST /servers/:id/drift/scan", method: "POST", path: () => `/api/v1/servers/${serverId}/drift/scan` },
  { name: "POST /servers/:id/drift/baseline", method: "POST", path: () => `/api/v1/servers/${serverId}/drift/baseline` },
  { name: "GET /drift/events", method: "GET", path: () => "/api/v1/drift/events" },
  { name: "GET /drift/summary", method: "GET", path: () => "/api/v1/drift/summary" },
  { name: "POST /drift/events/:id/acknowledge", method: "POST", path: () => "/api/v1/drift/events/1/acknowledge" },
];

function request(method: string, path: string, cookie?: string) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });
}

async function seedDrift() {
  await prisma.driftEvent.deleteMany({ where: { serverId } });
  await prisma.serverSnapshot.deleteMany({ where: { serverId } });
  const data = { v: 1, ranAsRoot: true, users: [], groups: {}, sudoers: [], crontabs: {}, ports: [], units: [], authorizedKeys: {}, unavailable: {}, warnings: [] };
  await prisma.serverSnapshot.create({ data: { serverId, data, hash: "a".repeat(64), isBaseline: true } });
  const latest = await prisma.serverSnapshot.create({ data: { serverId, data: { ...data, units: ["nginx.service"] }, hash: "b".repeat(64) } });
  const event = await prisma.driftEvent.create({
    data: {
      serverId,
      category: "units",
      severity: "info",
      summary: "Enabled systemd units: 1 added — Unit nginx.service enabled",
      changes: { added: [{ key: "nginx.service", label: "Unit nginx.service enabled", severity: "info" }], removed: [], changed: [] },
      snapshotId: latest.id,
    },
  });
  return { latest, event };
}

describe("drift route guards", () => {
  it.each(ROUTES)("rejects an unauthenticated caller: $name", async (c) => {
    const res = await request(c.method, c.path());
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)("rejects a viewer: $name", async (c) => {
    const res = await request(c.method, c.path(), viewerCookie);
    expect(res.status).toBe(403);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it("refuses an editor (no server:sudo) accepting a baseline", async () => {
    await seedDrift();
    const res = await request("POST", `/api/v1/servers/${serverId}/drift/baseline`, editorCookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/server:sudo/);
    expect(await prisma.serverSnapshot.count({ where: { serverId, isBaseline: true, hash: "b".repeat(64) } })).toBe(0);
  });

  it("lets an editor read, list and acknowledge", async () => {
    const { event } = await seedDrift();
    const view = await request("GET", `/api/v1/servers/${serverId}/drift`, editorCookie);
    expect(view.status).toBe(200);
    const v = (await view.json()) as { matchesBaseline: boolean; openCounts: { total: number } };
    expect(v).toMatchObject({ matchesBaseline: false, openCounts: { total: 1 } });

    const list = await request("GET", `/api/v1/drift/events?status=open&serverId=${serverId}`, editorCookie);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { id: number }[] }).items.map((i) => i.id)).toEqual([event.id]);

    const summary = await request("GET", "/api/v1/drift/summary", editorCookie);
    expect(summary.status).toBe(200);
    const s = (await summary.json()) as { servers: { serverId: number; maxSeverity: string }[] };
    expect(s.servers.find((x) => x.serverId === serverId)?.maxSeverity).toBe("info");

    const ack = await request("POST", `/api/v1/drift/events/${event.id}/acknowledge`, editorCookie);
    expect(ack.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "drift.acknowledge", entityId: String(event.id) } })).toBe(1);
  });

  it("lets an admin accept the baseline", async () => {
    const { latest } = await seedDrift();
    const res = await request("POST", `/api/v1/servers/${serverId}/drift/baseline`, adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { baseline: { id: number }; acknowledged: number };
    expect(body).toMatchObject({ baseline: { id: latest.id }, acknowledged: 1 });
  });

  it("maps an unreachable host on scan to 503", async () => {
    mocks.connectToServer.mockRejectedValueOnce(new SshError("unreachable", "connect ETIMEDOUT"));
    const res = await request("POST", `/api/v1/servers/${serverId}/drift/scan`, editorCookie);
    expect(res.status).toBe(503);
  });

  it("validates the events query", async () => {
    const res = await request("GET", "/api/v1/drift/events?severity=bogus", editorCookie);
    expect(res.status).toBe(400);
  });
});
