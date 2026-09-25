import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";

/**
 * Regression guard for the v0.6.1 authorization fixes.
 *
 * Every route below was reachable by any authenticated user — including a
 * viewer — before v0.6.1. Several of them execute commands on managed hosts or
 * disclose configuration. If a future change drops a `requirePermission`, the
 * matching case here fails.
 *
 * The assertion is deliberately "not 2xx and not 404-because-of-routing": these
 * must reject on authorization, before any handler work happens.
 */

const app = createApp();

let viewerCookie = "";

beforeAll(async () => {
  viewerCookie = await loginAs(app, "viewer");
});

type Case = { name: string; method: string; path: string; body?: unknown };

const VIEWER_MUST_NOT_REACH: Case[] = [
  // Executes a shell script on the managed host over SSH.
  { name: "GET /servers/:id/auto-update", method: "GET", path: "/api/v1/servers/1/auto-update" },
  // Discloses notification config, including the Telegram chat id in clear.
  { name: "GET /servers/:id/alert-channels", method: "GET", path: "/api/v1/servers/1/alert-channels" },
  // Lists host SSH keys.
  { name: "GET /ssh-keys", method: "GET", path: "/api/v1/ssh-keys" },
  // An online SSH credential-guessing oracle.
  {
    name: "POST /ssh-keys/test-server/:id",
    method: "POST",
    path: "/api/v1/ssh-keys/test-server/1",
    body: { authMethod: "password", password: "guess" },
  },
  // Fleet-wide outbound TLS scan.
  { name: "POST /ssl/scan", method: "POST", path: "/api/v1/ssl/scan" },
  { name: "POST /ssl/:id/scan", method: "POST", path: "/api/v1/ssl/1/scan" },
  // Connects out to an attacker-chosen domain.
  { name: "POST /ssl", method: "POST", path: "/api/v1/ssl", body: { domain: "example.com" } },
  { name: "PATCH /ssl/:id", method: "PATCH", path: "/api/v1/ssl/1", body: { team: "x" } },
  { name: "DELETE /ssl/:id", method: "DELETE", path: "/api/v1/ssl/1" },
  { name: "POST /ssl/:id/restore", method: "POST", path: "/api/v1/ssl/1/restore" },
  // Writes the master vault passphrase to disk / fleet-wide decryption DoS.
  {
    name: "POST /vault/unlock-global",
    method: "POST",
    path: "/api/v1/vault/unlock-global",
    body: { passphrase: "irrelevant", persistToEnv: true },
  },
  { name: "POST /vault/lock-global", method: "POST", path: "/api/v1/vault/lock-global" },
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

describe("authorization guards (v0.6.1 regression)", () => {
  it.each(VIEWER_MUST_NOT_REACH)("rejects an unauthenticated caller: $name", async (c) => {
    const res = await request(c);
    expect(res.status).toBe(401);
  });

  it.each(VIEWER_MUST_NOT_REACH)("rejects a viewer: $name", async (c) => {
    const res = await request(c, viewerCookie);
    expect(res.status).toBe(403);
  });
});

describe("editor is not silently promoted to admin (v0.6.1 regression)", () => {
  let editorCookie = "";

  beforeAll(async () => {
    editorCookie = await loginAs(app, "editor");
  });

  // These were gated on `server:update`, which an editor holds, despite being
  // commented "admin only". They now require admin-level vault permissions.
  it("editor cannot unlock the vault globally", async () => {
    const res = await app.request("/api/v1/vault/unlock-global", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: editorCookie },
      body: JSON.stringify({ passphrase: "irrelevant", persistToEnv: true }),
    });
    expect(res.status).toBe(403);
  });

  it("editor cannot lock the vault globally", async () => {
    const res = await app.request("/api/v1/vault/lock-global", {
      method: "POST",
      headers: { Cookie: editorCookie },
    });
    expect(res.status).toBe(403);
  });
});

describe("public config endpoint", () => {
  it("is reachable without a session and only advertises UI flags", async () => {
    const res = await app.request("/api/v1/public/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["allowSelfSignup", "billingEnabled"]);
    expect(typeof body["allowSelfSignup"]).toBe("boolean");
    expect(typeof body["billingEnabled"]).toBe("boolean");
  });
});
