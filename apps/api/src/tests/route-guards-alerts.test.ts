import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createApp } from "../app.js";
import { resetRateLimits } from "../middleware/rate-limit.js";
import { loginAs } from "./helpers.js";

/**
 * Authorization guards for alert channels (admin manages, editor reads) and
 * the per-server alert routes. Guards are per route, so every route is listed:
 * a handler added without requirePermission fails here.
 */

const app = createApp();
let viewer = "";
let editor = "";

beforeAll(async () => {
  viewer = await loginAs(app, "viewer");
  editor = await loginAs(app, "editor");
});
beforeEach(() => resetRateLimits());

type Case = { name: string; method: string; path: string; body?: unknown };

const slackDraft = { type: "slack", name: "x", url: "https://hooks.slack.com/services/T0/B0/x", events: ["test"] };

/** Mutations and admin-only reads: viewer AND editor must be refused. */
const MANAGE_ROUTES: Case[] = [
  { name: "POST /alert-channels", method: "POST", path: "/api/v1/alert-channels", body: slackDraft },
  { name: "PATCH /alert-channels/:id", method: "PATCH", path: "/api/v1/alert-channels/1", body: { enabled: false } },
  { name: "DELETE /alert-channels/:id", method: "DELETE", path: "/api/v1/alert-channels/1" },
  { name: "POST /alert-channels/:id/test", method: "POST", path: "/api/v1/alert-channels/1/test" },
  { name: "POST /alert-channels/test", method: "POST", path: "/api/v1/alert-channels/test", body: slackDraft },
  { name: "GET /alert-channels/:id/deliveries", method: "GET", path: "/api/v1/alert-channels/1/deliveries" },
  { name: "GET /alert-events", method: "GET", path: "/api/v1/alert-events" },
  // A test alert fans out to every routed channel — admin only (it used to be server:update).
  { name: "POST /servers/:id/test-alert", method: "POST", path: "/api/v1/servers/1/test-alert" },
];

/** Readable by editors, not by viewers. */
const READ_ROUTES: Case[] = [
  { name: "GET /alert-channels", method: "GET", path: "/api/v1/alert-channels" },
  { name: "GET /alert-channels/:id", method: "GET", path: "/api/v1/alert-channels/1" },
  { name: "GET /servers/:id/alert-channels", method: "GET", path: "/api/v1/servers/1/alert-channels" },
];

function request(c: Case, cookie?: string) {
  return app.request(c.path, {
    method: c.method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
}

describe("alert route guards", () => {
  it.each([...MANAGE_ROUTES, ...READ_ROUTES])("rejects an unauthenticated caller: $name", async (c) => {
    expect((await request(c)).status).toBe(401);
  });

  it.each([...MANAGE_ROUTES, ...READ_ROUTES])("rejects a viewer: $name", async (c) => {
    expect((await request(c, viewer)).status).toBe(403);
  });

  it.each(MANAGE_ROUTES)("rejects an editor: $name", async (c) => {
    expect((await request(c, editor)).status).toBe(403);
  });

  it.each(READ_ROUTES)("lets an editor through the guard: $name", async (c) => {
    const status = (await request(c, editor)).status;
    // 404 is fine (fixture ids need not exist) — the point is it is not 401/403.
    expect([200, 404]).toContain(status);
  });

  it("an API key cannot be used to spoof its way past: bogus bearer is 401", async () => {
    const res = await app.request("/api/v1/alert-channels", { headers: { Authorization: "Bearer sk_bogus" } });
    expect(res.status).toBe(401);
  });
});
