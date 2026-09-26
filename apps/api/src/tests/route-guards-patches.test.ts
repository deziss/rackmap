import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { applyOutput, execResult, scanOutput } from "./patch-fixtures.js";

/**
 * Authorization guards for the patch routes. The SSH layer is replaced by
 * spies that fail loudly, so the 403 cases also prove no SSH session was
 * opened (the sudo check for apply runs before anything touches the host).
 */

const mocks = vi.hoisted(() => ({ connectToServer: vi.fn(), execPreferRoot: vi.fn(), execAsRoot: vi.fn() }));
vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});
vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execPreferRoot: mocks.execPreferRoot, execAsRoot: mocks.execAsRoot };
});
// The license gate is not under test; the happy paths need to get past it.
vi.mock("../services/license.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/license.service.js")>()),
  assertFeatureEnabled: vi.fn(async () => {}),
}));

const { createApp } = await import("../app.js");
const { loginAs } = await import("./helpers.js");
const { prisma } = await import("../db.js");
const { waitForPatchScans } = await import("../services/patch.service.js");

const app = createApp();
let serverId = 0;
let viewerCookie = "";
let editorCookie = "";
let adminCookie = "";

type Case = { name: string; method: string; path: () => string; body?: unknown };

const ROUTES: Case[] = [
  { name: "GET /servers/:id/patches", method: "GET", path: () => `/api/v1/servers/${serverId}/patches` },
  { name: "POST /servers/:id/patches/scan", method: "POST", path: () => `/api/v1/servers/${serverId}/patches/scan`, body: {} },
  {
    name: "POST /servers/:id/patches/apply",
    method: "POST",
    path: () => `/api/v1/servers/${serverId}/patches/apply`,
    body: { mode: "security" },
  },
  { name: "GET /patches", method: "GET", path: () => "/api/v1/patches" },
  { name: "GET /patches/summary", method: "GET", path: () => "/api/v1/patches/summary" },
  { name: "POST /patches/scan", method: "POST", path: () => "/api/v1/patches/scan", body: {} },
];
const WRITES = ROUTES.filter((r) => r.method === "POST");
const READS = ROUTES.filter((r) => r.method === "GET");

function request(c: Case, cookie?: string, body = c.body) {
  return app.request(c.path(), {
    method: c.method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  const s = await prisma.server.create({
    data: { hostname: "patch-guard-1.example.com", ip: "192.0.2.61", username: "deploy" },
  });
  serverId = s.id;
  viewerCookie = await loginAs(app, "viewer");
  editorCookie = await loginAs(app, "editor");
  adminCookie = await loginAs(app, "admin");
});

beforeEach(() => {
  mocks.connectToServer.mockReset().mockRejectedValue(new Error("SSH must not be reached in this test"));
  mocks.execPreferRoot.mockReset().mockRejectedValue(new Error("the host must not be reached in this test"));
  mocks.execAsRoot.mockReset().mockRejectedValue(new Error("the host must not be reached in this test"));
});

function fakeHost() {
  mocks.connectToServer.mockImplementation(async (id: number) => ({
    client: { end: vi.fn() },
    password: "ssh-pw",
    target: { id, hostname: "patch-guard-1.example.com", ip: "192.0.2.61", username: "deploy", sshPort: 22 },
  }));
  mocks.execPreferRoot.mockImplementation(async () => ({ ...execResult(scanOutput()), ranAsRoot: true }));
}

describe("patch route guards", () => {
  it.each(ROUTES)("rejects an unauthenticated caller: $name", async (c) => {
    const res = await request(c);
    expect(res.status).toBe(401);
  });

  it.each(WRITES)("rejects a viewer: $name", async (c) => {
    const res = await request(c, viewerCookie);
    expect(res.status).toBe(403);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it.each(READS)("lets a viewer read: $name", async (c) => {
    const res = await request(c, viewerCookie);
    expect(res.status).toBe(200);
  });

  it("an editor without server:sudo gets 403 on apply before any SSH", async () => {
    fakeHost();
    const res = await request(WRITES.find((r) => r.name.includes("apply"))!, editorCookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/server:sudo/);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
    expect(mocks.execAsRoot).not.toHaveBeenCalled();
  });

  it("validates the apply mode", async () => {
    const res = await request(WRITES.find((r) => r.name.includes("apply"))!, adminCookie, { mode: "everything" });
    expect(res.status).toBe(400);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });
});

describe("patch routes on a fake host", () => {
  it("lets an editor scan one server and records the result", async () => {
    fakeHost();
    const res = await request(ROUTES[1]!, editorCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ serverId, status: "ok", packageManager: "apt" });
    const get = await request(ROUTES[0]!, viewerCookie);
    expect(await get.json()).toMatchObject({ serverId, status: "ok" });
    expect(await prisma.auditLog.count({ where: { action: "server.patch_scan", entityId: String(serverId) } })).toBe(1);
  });

  it("maps an unreachable host to 503", async () => {
    const { SshError } = await import("../services/ssh.service.js");
    mocks.connectToServer.mockRejectedValue(new SshError("unreachable", "connect ETIMEDOUT"));
    const res = await request(ROUTES[1]!, editorCookie);
    expect(res.status).toBe(503);
  });

  it("queues fleet scans and answers 202 with the count", async () => {
    fakeHost();
    const res = await request(WRITES.find((r) => r.name === "POST /patches/scan")!, editorCookie, { serverIds: [serverId, 999_999] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 1 });
    await waitForPatchScans();
    expect(mocks.connectToServer).toHaveBeenCalledTimes(1);
  });

  it("lets an admin apply updates", async () => {
    fakeHost();
    mocks.execAsRoot.mockResolvedValue(execResult(applyOutput({ rc: "0" })));
    const res = await request(ROUTES[2]!, adminCookie, { mode: "all" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "all", exitCode: 0 });
  });

  it("answers 409 with a clear message when apt security-only is not possible", async () => {
    fakeHost();
    mocks.execAsRoot.mockResolvedValue(execResult(applyOutput({ refused: "NO_UNATTENDED_UPGRADE" })));
    const res = await request(ROUTES[2]!, adminCookie, { mode: "security" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/unattended-upgrades/);
  });

  it("lists the fleet and the summary", async () => {
    const list = await request(ROUTES[3]!, viewerCookie);
    const body = (await list.json()) as { items: { serverId: number }[]; total: number };
    expect(body.items.some((i) => i.serverId === serverId)).toBe(true);
    const summary = await request(ROUTES[4]!, viewerCookie);
    expect(await summary.json()).toMatchObject({ scanned: expect.any(Number), scanning: 0 });
  });

  it("404s for a server that does not exist", async () => {
    const res = await app.request("/api/v1/servers/999999/patches", { headers: { Cookie: viewerCookie } });
    expect(res.status).toBe(404);
  });
});
