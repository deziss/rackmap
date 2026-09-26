import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";

/**
 * Authorization guards for heartbeats and cron monitoring.
 *
 * viewer: read only · editor: create/update · admin: delete. Monitoring a cron
 * job rewrites a crontab on a managed host, so it needs server:cron on top of the
 * heartbeat permission. These must reject on authorization before any handler
 * work (the ids below need not exist).
 */

const app = createApp();

let viewerCookie = "";
let editorCookie = "";

beforeAll(async () => {
  [viewerCookie, editorCookie] = await Promise.all([loginAs(app, "viewer"), loginAs(app, "editor")]);
});

type Case = { name: string; method: string; path: string; body?: unknown };

const cronBody = { target: { kind: "user", user: "deploy" }, baseHash: "a".repeat(64), lineNo: 1 };

const VIEWER_MUST_NOT_REACH: Case[] = [
  { name: "POST /heartbeats", method: "POST", path: "/api/v1/heartbeats", body: { name: "x", kind: "period", periodSeconds: 3600 } },
  { name: "PATCH /heartbeats/:id", method: "PATCH", path: "/api/v1/heartbeats/1", body: { name: "x" } },
  { name: "DELETE /heartbeats/:id", method: "DELETE", path: "/api/v1/heartbeats/1" },
  { name: "POST /heartbeats/:id/rotate-token", method: "POST", path: "/api/v1/heartbeats/1/rotate-token", body: {} },
  { name: "POST /heartbeats/:id/pause", method: "POST", path: "/api/v1/heartbeats/1/pause" },
  { name: "POST /heartbeats/:id/resume", method: "POST", path: "/api/v1/heartbeats/1/resume" },
  { name: "POST /servers/:id/cron/monitor", method: "POST", path: "/api/v1/servers/1/cron/monitor", body: cronBody },
  { name: "POST /servers/:id/cron/unmonitor", method: "POST", path: "/api/v1/servers/1/cron/unmonitor", body: cronBody },
];

const READS: Case[] = [
  { name: "GET /heartbeats", method: "GET", path: "/api/v1/heartbeats" },
  { name: "GET /heartbeats/config", method: "GET", path: "/api/v1/heartbeats/config" },
  { name: "GET /heartbeats/:id", method: "GET", path: "/api/v1/heartbeats/1" },
  { name: "GET /heartbeats/:id/pings", method: "GET", path: "/api/v1/heartbeats/1/pings" },
];

const EDITOR_MUST_NOT_REACH: Case[] = [{ name: "DELETE /heartbeats/:id", method: "DELETE", path: "/api/v1/heartbeats/1" }];

function request(c: Case, headers: Record<string, string> = {}) {
  return app.request(c.path, {
    method: c.method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
}

describe("heartbeat route guards", () => {
  it.each([...VIEWER_MUST_NOT_REACH, ...READS])("rejects an unauthenticated caller: $name", async (c) => {
    expect((await request(c)).status).toBe(401);
  });

  it.each(VIEWER_MUST_NOT_REACH)("rejects a viewer: $name", async (c) => {
    expect((await request(c, { Cookie: viewerCookie })).status).toBe(403);
  });

  it.each(EDITOR_MUST_NOT_REACH)("rejects an editor: $name", async (c) => {
    expect((await request(c, { Cookie: editorCookie })).status).toBe(403);
  });

  it("lets a viewer read", async () => {
    expect((await request(READS[0]!, { Cookie: viewerCookie })).status).toBe(200);
    expect((await request(READS[1]!, { Cookie: viewerCookie })).status).toBe(200);
  });

  it("rejects a bogus API key on management routes", async () => {
    expect((await request(READS[0]!, { Authorization: "Bearer sk_bogus" })).status).toBe(401);
  });
});

describe("ping endpoint is public", () => {
  it("answers 404 for an unknown token without a cookie and with a bogus key", async () => {
    const token = randomBytes(32).toString("base64url");
    expect((await app.request(`/api/v1/ping/${token}`)).status).toBe(404);
    expect((await app.request(`/api/v1/ping/${token}`, { headers: { Authorization: "Bearer sk_x" } })).status).toBe(404);
    expect((await app.request(`/api/v1/ping/${token}/start`, { method: "POST" })).status).toBe(404);
  });
});
