import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * Authorization guards for the systemd service manager routes. The SSH layer is
 * replaced by a spy, so a request that gets past the guards fails loudly — and
 * the protected-unit cases assert the spy was never reached (the static rule
 * runs before license and SSH).
 */

const mocks = vi.hoisted(() => ({ connectToServer: vi.fn(), execAsRoot: vi.fn(), execPreferRoot: vi.fn() }));
vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});
vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execAsRoot: mocks.execAsRoot, execPreferRoot: mocks.execPreferRoot };
});
// The license gate is not under test; the allowed-action cases need to get past it.
vi.mock("../services/license.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/license.service.js")>()),
  assertFeatureEnabled: vi.fn(async () => {}),
}));

const { createApp } = await import("../app.js");
const { loginAs } = await import("./helpers.js");
const actualSsh = await vi.importActual<typeof import("../services/ssh.service.js")>("../services/ssh.service.js");

const app = createApp();
/** No server has this id in the test database. */
const MISSING_SERVER = 987_654;

let viewerCookie = "";
let editorCookie = "";
let adminCookie = "";

beforeAll(async () => {
  viewerCookie = await loginAs(app, "viewer");
  editorCookie = await loginAs(app, "editor");
  adminCookie = await loginAs(app, "admin");
});

beforeEach(() => {
  mocks.connectToServer.mockReset().mockRejectedValue(new Error("SSH must not be reached in this test"));
  mocks.execAsRoot.mockReset().mockRejectedValue(new Error("the host must not be reached in this test"));
  mocks.execPreferRoot.mockReset().mockRejectedValue(new Error("the host must not be reached in this test"));
});

type Case = { name: string; method: string; path: string; body?: unknown };

const SYSTEMD_ROUTES: Case[] = [
  { name: "GET units", method: "GET", path: "/api/v1/servers/1/systemd/units?type=service" },
  { name: "GET unit", method: "GET", path: "/api/v1/servers/1/systemd/units/nginx.service" },
  { name: "GET unit logs", method: "GET", path: "/api/v1/servers/1/systemd/units/nginx.service/logs?lines=50&since=1h" },
  { name: "POST action", method: "POST", path: "/api/v1/servers/1/systemd/units/nginx.service/action", body: { action: "restart" } },
];

function request(c: Case, cookie?: string) {
  return app.request(c.path, {
    method: c.method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
}

function action(unit: string, act: string, serverId = 1): Case {
  return {
    name: `${act} ${unit}`,
    method: "POST",
    path: `/api/v1/servers/${serverId}/systemd/units/${encodeURIComponent(unit)}/action`,
    body: { action: act },
  };
}

describe("systemd route guards", () => {
  it.each(SYSTEMD_ROUTES)("rejects an unauthenticated caller: $name", async (c) => {
    const res = await request(c);
    expect(res.status).toBe(401);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it.each(SYSTEMD_ROUTES)("rejects a viewer: $name", async (c) => {
    const res = await request(c, viewerCookie);
    expect(res.status).toBe(403);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it("rejects a viewer even for a protected unit or a bad name (permission before validation)", async () => {
    expect((await request(action("sshd.service", "stop"), viewerCookie)).status).toBe(403);
    expect((await request(action("x;reboot.service", "stop"), viewerCookie)).status).toBe(403);
  });

  it.each([
    action("sshd.service", "stop"),
    action("ssh.service", "restart"),
    action("docker.service", "disable"),
    action("getty@tty1.service", "stop"),
    action("reboot.target", "start"),
  ])("an editor without server:sudo gets 403 before any SSH: $name", async (c) => {
    const res = await request(c, editorCookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toMatch(/server:sudo/);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it.each([
    { name: "hostile unit name", c: action("$(reboot).service", "restart") },
    { name: "unit without a type suffix", c: action("nginx", "restart") },
    { name: "unknown action", c: action("nginx.service", "mask") },
    { name: "lines out of range", c: { name: "logs", method: "GET", path: "/api/v1/servers/1/systemd/units/nginx.service/logs?lines=5000" } },
    { name: "hostile since", c: { name: "logs", method: "GET", path: `/api/v1/servers/1/systemd/units/nginx.service/logs?since=${encodeURIComponent("1h; reboot")}` } },
    { name: "unknown type", c: { name: "list", method: "GET", path: "/api/v1/servers/1/systemd/units?type=device" } },
  ])("an editor gets 400 before any SSH: $name", async ({ c }) => {
    const res = await request(c, editorCookie);
    expect(res.status).toBe(400);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });
});

describe("systemd routes on a missing server", () => {
  beforeEach(() => {
    // The real connectToServer: it looks the server up and throws not_found.
    mocks.connectToServer.mockImplementation(actualSsh.connectToServer);
  });

  it("404s an editor's allowed action", async () => {
    const res = await request(action("nginx.service", "restart", MISSING_SERVER), editorCookie);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(mocks.connectToServer).toHaveBeenCalledTimes(1);
    expect(mocks.execAsRoot).not.toHaveBeenCalled();
  });

  it("404s an editor's read", async () => {
    const res = await request({ name: "list", method: "GET", path: `/api/v1/servers/${MISSING_SERVER}/systemd/units` }, editorCookie);
    expect(res.status).toBe(404);
  });

  it("lets an admin (server:sudo) past the protected-unit rule", async () => {
    const res = await request(action("sshd.service", "stop", MISSING_SERVER), adminCookie);
    expect(res.status).toBe(404);
    expect(mocks.connectToServer).toHaveBeenCalledTimes(1);
  });
});
