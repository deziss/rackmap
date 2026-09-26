import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * Authorization guards for the cron editor routes. The SSH layer is replaced by
 * a spy, so a request that gets past the guards fails loudly — and the sudo
 * cases assert the spy was never reached (the static rule runs before SSH).
 */

const mocks = vi.hoisted(() => ({ connectToServer: vi.fn(), execAsRoot: vi.fn() }));
vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});
vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execAsRoot: mocks.execAsRoot };
});
// The license gate is not under test; the privileged-user cases need to get past it.
vi.mock("../services/license.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/license.service.js")>()),
  assertFeatureEnabled: vi.fn(async () => {}),
}));

const { createApp } = await import("../app.js");
const { loginAs } = await import("./helpers.js");
const { SshError } = await import("../services/ssh.service.js");

const app = createApp();
const HASH = "0".repeat(64);

let viewerCookie = "";
let editorCookie = "";

beforeAll(async () => {
  viewerCookie = await loginAs(app, "viewer");
  editorCookie = await loginAs(app, "editor");
});

beforeEach(() => {
  mocks.connectToServer.mockReset().mockRejectedValue(new Error("SSH must not be reached in this test"));
  mocks.execAsRoot.mockReset().mockRejectedValue(new Error("the host must not be reached in this test"));
});

type Case = { name: string; method: string; path: string; body?: unknown };

const CRON_ROUTES: Case[] = [
  { name: "GET /servers/:id/cron", method: "GET", path: "/api/v1/servers/1/cron" },
  {
    name: "PUT /servers/:id/cron",
    method: "PUT",
    path: "/api/v1/servers/1/cron",
    body: { target: { kind: "user", user: "alice" }, content: "", baseHash: HASH },
  },
  {
    name: "POST /servers/:id/cron/run",
    method: "POST",
    path: "/api/v1/servers/1/cron/run",
    body: { target: { kind: "user", user: "alice" }, lineNo: 1, baseHash: HASH },
  },
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

describe("cron route guards", () => {
  it.each(CRON_ROUTES)("rejects an unauthenticated caller: $name", async (c) => {
    const res = await request(c);
    expect(res.status).toBe(401);
  });

  it.each(CRON_ROUTES)("rejects a viewer: $name", async (c) => {
    const res = await request(c, viewerCookie);
    expect(res.status).toBe(403);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  const SUDO_ONLY: Case[] = [
    {
      name: "PUT /etc/crontab",
      method: "PUT",
      path: "/api/v1/servers/1/cron",
      body: { target: { kind: "system" }, content: "", baseHash: HASH },
    },
    {
      name: "PUT /etc/cron.d file",
      method: "PUT",
      path: "/api/v1/servers/1/cron",
      body: { target: { kind: "crond", file: "rackmap-x" }, content: "", baseHash: HASH },
    },
    {
      name: "PUT root's crontab",
      method: "PUT",
      path: "/api/v1/servers/1/cron",
      body: { target: { kind: "user", user: "root" }, content: "", baseHash: HASH },
    },
    {
      name: "POST run on /etc/crontab",
      method: "POST",
      path: "/api/v1/servers/1/cron/run",
      body: { target: { kind: "system" }, lineNo: 1, baseHash: HASH },
    },
  ];

  it.each(SUDO_ONLY)("an editor without server:sudo gets 403 before any SSH: $name", async (c) => {
    const res = await request(c, editorCookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/server:sudo/);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it("rejects a cron.d name cron would ignore with 400", async () => {
    const res = await request(
      {
        name: "bad name",
        method: "PUT",
        path: "/api/v1/servers/1/cron",
        body: { target: { kind: "crond", file: "php.dpkg-old" }, content: "", baseHash: HASH },
      },
      editorCookie,
    );
    expect(res.status).toBe(400);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });
});

describe("cron routes on a host that reports a privileged owner", () => {
  const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");
  const CRONTAB = "@daily cat /etc/shadow\n";
  const scripts: string[] = [];

  beforeEach(() => {
    scripts.length = 0;
    mocks.connectToServer.mockResolvedValue({
      client: { end: vi.fn() },
      password: "ssh-pw",
      target: { id: 1, hostname: "web-1.example.com", ip: "192.0.2.1", username: "deploy", sshPort: 22 },
    });
    // Answers only the read script, with sam in group shadow; a write or run script fails the test.
    mocks.execAsRoot.mockImplementation(async (_client: unknown, script: string) => {
      scripts.push(script);
      if (script.includes("runuser") || script.includes("base64 -d")) throw new Error("write/run script must not be sent");
      return {
        exitCode: 0,
        stdout: `===TZ===\n${b64("UTC")}\n===USER:sam===\n${b64(CRONTAB)}\n===PRIV:sam===\n${b64("group:shadow")}\n===END===\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        cancelled: false,
        durationMs: 5,
      };
    });
  });

  const baseHash = createHash("sha256").update(CRONTAB).digest("hex");
  const SHADOW: Case[] = [
    {
      name: "PUT a shadow-group user's crontab",
      method: "PUT",
      path: "/api/v1/servers/1/cron",
      body: { target: { kind: "user", user: "sam" }, content: "@hourly cat /etc/shadow\n", baseHash },
    },
    {
      name: "POST run a shadow-group user's job",
      method: "POST",
      path: "/api/v1/servers/1/cron/run",
      body: { target: { kind: "user", user: "sam" }, lineNo: 1, baseHash },
    },
  ];

  it.each(SHADOW)("an editor without server:sudo gets 403 after the host read: $name", async (c) => {
    const res = await request(c, editorCookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/group:shadow.*server:sudo/);
    expect(scripts).toHaveLength(1);
  });
});

describe("cron route error codes", () => {
  it("passes VAULT_LOCKED through so the cron tab can prompt to unlock", async () => {
    mocks.connectToServer.mockRejectedValue(new SshError("vault_locked", "vault locked"));
    const res = await request(CRON_ROUTES[0]!, editorCookie);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VAULT_LOCKED");
  });
});
