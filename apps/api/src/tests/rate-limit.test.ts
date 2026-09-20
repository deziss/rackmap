import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import { rateLimit, callerIdentity, resetRateLimits } from "../middleware/rate-limit.js";

/**
 * Brute-force protection on the credential-bearing endpoints.
 *
 * Before this, the only rate limit in the API covered `/api/auth/*`. Password
 * reveals and the SSH credential test — an online password oracle — were
 * unbounded, so a stolen editor session could dump the fleet in one loop.
 *
 * The limiter is per-process module state, and vitest runs every file in a
 * single fork, so each case resets the counters first.
 */

/** Minimal app exercising the middleware directly, with an injected identity. */
function makeApp(opts: { windowMs: number; max: number; key?: (c: Context) => string }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const id = c.req.header("x-test-user");
    if (id) c.set("user", { id, email: `${id}@test.local`, name: id, role: "editor" });
    await next();
  });
  app.post("/thing/:id", rateLimit(opts), (c) => c.json({ ok: true }));
  return app;
}

const asUser = (id: string) => ({ headers: { "x-test-user": id }, method: "POST" });

beforeEach(() => {
  resetRateLimits();
});

describe("rateLimit middleware", () => {
  it("allows exactly `max` requests in a window and rejects the next with 429", async () => {
    const app = makeApp({ windowMs: 60_000, max: 3 });

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/thing/1", asUser("alice"));
      expect(res.status, `request ${i + 1} of 3 should pass`).toBe(200);
    }

    const blocked = await app.request("/thing/1", asUser("alice"));
    expect(blocked.status).toBe(429);
  });

  it("returns the standard error envelope and a Retry-After header on 429", async () => {
    const app = makeApp({ windowMs: 60_000, max: 1 });
    await app.request("/thing/1", asUser("alice"));
    const blocked = await app.request("/thing/1", asUser("alice"));

    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const body = (await blocked.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
    expect(typeof body.error?.message).toBe("string");
  });

  it("is keyed per user: exhausting user A does not block user B", async () => {
    const app = makeApp({ windowMs: 60_000, max: 2 });

    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(200);
    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(200);
    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(429);

    // Same route, same resource, different user — untouched budget.
    expect((await app.request("/thing/1", asUser("bob"))).status).toBe(200);
    expect((await app.request("/thing/1", asUser("bob"))).status).toBe(200);
    expect((await app.request("/thing/1", asUser("bob"))).status).toBe(429);
  });

  it("does not let a rotated X-Forwarded-For mint a fresh bucket", async () => {
    const app = makeApp({ windowMs: 60_000, max: 1 });

    const first = await app.request("/thing/1", {
      method: "POST",
      headers: { "x-test-user": "alice", "x-forwarded-for": "10.0.0.1" },
    });
    expect(first.status).toBe(200);

    const second = await app.request("/thing/1", {
      method: "POST",
      headers: { "x-test-user": "alice", "x-forwarded-for": "10.0.0.2" },
    });
    expect(second.status).toBe(429);
  });

  it("does not read x-forwarded-for for the anonymous fallback identity either", async () => {
    const app = new Hono();
    let seen = "";
    app.get("/id", (c) => {
      seen = callerIdentity(c);
      return c.json({ ok: true });
    });
    await app.request("/id", { headers: { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" } });
    expect(seen).not.toContain("203.0.113.9");
    expect(seen.startsWith("peer:")).toBe(true);
  });

  it("scopes the default key per resource, so one resource does not spend another's budget", async () => {
    const app = makeApp({ windowMs: 60_000, max: 1 });

    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(200);
    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(429);
    // Different :id — its own bucket.
    expect((await app.request("/thing/2", asUser("alice"))).status).toBe(200);
  });

  it("supports a per-user ceiling that ignores the resource", async () => {
    const app = makeApp({ windowMs: 60_000, max: 2, key: callerIdentity });

    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(200);
    expect((await app.request("/thing/2", asUser("alice"))).status).toBe(200);
    // Third distinct resource — the ceiling is already spent.
    expect((await app.request("/thing/3", asUser("alice"))).status).toBe(429);
  });

  it("resets the bucket once the window has elapsed", async () => {
    const windowMs = 80;
    const app = makeApp({ windowMs, max: 1 });

    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(200);
    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, windowMs + 40));

    expect((await app.request("/thing/1", asUser("alice"))).status).toBe(200);
  });
});

/**
 * The limiter is only useful if it is actually mounted. These hit the real app
 * so a future refactor that drops the middleware from a route fails here.
 *
 * Server id 999999 does not exist, so the handler ends in a 404 — irrelevant:
 * the assertion is about which requests reach a handler at all, and an attempt
 * has to cost budget whether or not it succeeds.
 */
describe("credential endpoints are rate limited in the real app", () => {
  const app = createApp();
  let adminCookie = "";
  let editorCookie = "";

  beforeAll(async () => {
    adminCookie = await loginAs(app, "admin");
    editorCookie = await loginAs(app, "editor");
  });

  function reveal(cookie: string, id: number) {
    return app.request(`/api/v1/servers/${id}/reveal-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
    });
  }

  it("bounds repeated reveals of one server at 5 per window", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await reveal(adminCookie, 999999);
      expect(res.status, `reveal ${i + 1} of 5 should reach the handler`).not.toBe(429);
    }

    const blocked = await reveal(adminCookie, 999999);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    const body = (await blocked.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
  });

  it("bounds one user without blocking another", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await reveal(adminCookie, 999999)).status).not.toBe(429);
    }
    expect((await reveal(adminCookie, 999999)).status).toBe(429);

    // A different operator still gets their own budget for the same server.
    expect((await reveal(editorCookie, 999999)).status).not.toBe(429);
  });

  it("caps fleet-wide enumeration at 20 reveals per user per window", async () => {
    // One request each against 20 distinct servers stays under the per-server
    // limit, so only the per-user ceiling can stop it.
    for (let id = 900001; id <= 900020; id++) {
      expect((await reveal(adminCookie, id)).status, `server ${id}`).not.toBe(429);
    }

    const blocked = await reveal(adminCookie, 900021);
    expect(blocked.status).toBe(429);
  });

  it("bounds the SSH credential-test oracle at 10 per server per window", async () => {
    const body = JSON.stringify({ authMethod: "password", password: "guess" });
    const test = () =>
      app.request("/api/v1/ssh-keys/test-server/999999", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body,
      });

    for (let i = 0; i < 10; i++) {
      expect((await test()).status, `attempt ${i + 1} of 10`).not.toBe(429);
    }

    const blocked = await test();
    expect(blocked.status).toBe(429);
    const parsed = (await blocked.json()) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("RATE_LIMITED");
  });
});
