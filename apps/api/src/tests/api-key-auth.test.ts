import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import { prisma } from "../db.js";

/**
 * API keys existed since 0.5 but nothing ever validated one — the middleware
 * was written and never mounted, so every key authenticated nothing. These
 * tests pin down the behaviour now that it is wired up.
 */

const app = createApp();

let adminCookie = "";
let viewerCookie = "";
const createdKeyIds: string[] = [];

/** Mint a key through the API and return the raw secret (shown once). */
async function mintKey(cookie: string, body: Record<string, unknown> = {}) {
  const res = await app.request("/api/v1/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, any>;
  if (json?.id) createdKeyIds.push(json.id);
  return { status: res.status, body: json };
}

function bearer(key: string) {
  return { Authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  [adminCookie, viewerCookie] = await Promise.all([loginAs(app, "admin"), loginAs(app, "viewer")]);
});

afterAll(async () => {
  if (createdKeyIds.length > 0) {
    await prisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } });
  }
});

describe("API key authentication", () => {
  it("authenticates a request that presents a valid key", async () => {
    const { body } = await mintKey(adminCookie, { name: "test-valid", scopeRole: "admin" });
    expect(body.key).toMatch(/^sk_/);

    const res = await app.request("/api/v1/me", { headers: bearer(body.key) });
    expect(res.status).toBe(200);
    const me = (await res.json()) as Record<string, any>;
    expect(me.role).toBe("admin");
  });

  it("returns the raw key exactly once, never on a subsequent list", async () => {
    const { body } = await mintKey(adminCookie, { name: "test-once" });
    expect(body.key).toBeTruthy();

    const res = await app.request("/api/v1/api-keys", { headers: { Cookie: adminCookie } });
    const keys = (await res.json()) as Array<Record<string, unknown>>;
    for (const k of keys) {
      expect(k).not.toHaveProperty("key");
    }
  });

  it("rejects a key that does not exist", async () => {
    const res = await app.request("/api/v1/me", { headers: bearer("sk_" + "0".repeat(64)) });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked key", async () => {
    const { body } = await mintKey(adminCookie, { name: "test-revoked" });
    const del = await app.request(`/api/v1/api-keys/${body.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(del.status).toBe(200);

    const res = await app.request("/api/v1/me", { headers: bearer(body.key) });
    expect(res.status).toBe(401);
  });

  it("rejects an expired key", async () => {
    const { body } = await mintKey(adminCookie, { name: "test-expired", expiresInDays: 1 });
    // Backdate the expiry rather than waiting a day.
    await prisma.apiKey.update({
      where: { id: body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await app.request("/api/v1/me", { headers: bearer(body.key) });
    expect(res.status).toBe(401);
  });

  it("leaves cookie authentication untouched when no key is presented", async () => {
    const res = await app.request("/api/v1/me", { headers: { Cookie: viewerCookie } });
    expect(res.status).toBe(200);
  });

  it("does not make public routes require authentication", async () => {
    const res = await app.request("/api/v1/public/config");
    expect(res.status).toBe(200);
  });
});

describe("API key privilege scoping", () => {
  it("caps an admin's key at the scope it was minted with", async () => {
    const { body } = await mintKey(adminCookie, { name: "test-scoped-viewer", scopeRole: "viewer" });

    const me = await app.request("/api/v1/me", { headers: bearer(body.key) });
    expect(((await me.json()) as Record<string, unknown>)["role"]).toBe("viewer");

    // viewer holds no server:create, so a mutation must be refused even though
    // the key belongs to an admin.
    const res = await app.request("/api/v1/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(body.key) },
      body: JSON.stringify({ hostname: "scoped-test", ip: "10.0.0.1", username: "root" }),
    });
    expect(res.status).toBe(403);
  });

  it("defaults to the least privileged scope when none is given", async () => {
    const { body } = await mintKey(adminCookie, { name: "test-default-scope" });
    const me = await app.request("/api/v1/me", { headers: bearer(body.key) });
    expect(((await me.json()) as Record<string, unknown>)["role"]).toBe("viewer");
  });

  it("refuses to mint a key more privileged than the creator", async () => {
    const { status } = await mintKey(viewerCookie, { name: "test-escalate", scopeRole: "admin" });
    expect(status).toBe(403);
  });
});
