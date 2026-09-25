import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import { prisma } from "../db.js";

/**
 * Route guards for /api/v1/access-grants. Every refusal here must happen before
 * any SSH connection: the servers are TEST-NET addresses nothing listens on, so
 * a guard that let a request through would surface as a 503, not a 403.
 */

// Grants are a Pro feature (access_expiry); switch the tier via the license row.
let savedLicense: Awaited<ReturnType<typeof prisma.systemLicense.findFirst>> | undefined;

async function setLicenseTier(tier: "free" | "pro"): Promise<void> {
  if (savedLicense === undefined) savedLicense = await prisma.systemLicense.findFirst({ where: { id: 1 } });
  if (tier === "free") {
    await prisma.systemLicense.deleteMany({ where: { id: 1 } });
    return;
  }
  const data = { key: "LIC-TEST-ACCESS-PRO-0001", tier: "pro", maxServers: -1, featuresJson: "{}", expiresAt: null };
  await prisma.systemLicense.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
}

async function restoreLicense(): Promise<void> {
  if (savedLicense === undefined) return;
  await prisma.systemLicense.deleteMany({ where: { id: 1 } });
  if (savedLicense) {
    const { updatedAt: _u, ...rest } = savedLicense;
    await prisma.systemLicense.create({ data: rest });
  }
  savedLicense = undefined;
}

const app = createApp();
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIaRzUDCUCz5Uanal7pq91W1zKAxtET/tL5dSBAEtoMm fixture@example.com";

let adminCookie = "";
let editorCookie = "";
let viewerCookie = "";
let adminId = "";
let editorId = "";
let serverId = 0;

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function send(method: string, path: string, body: unknown, cookie?: string) {
  return app.request(`/api/v1/access-grants${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

beforeAll(async () => {
  adminCookie = await loginAs(app, "admin");
  editorCookie = await loginAs(app, "editor");
  viewerCookie = await loginAs(app, "viewer");
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@inventory.local" } })).id;
  editorId = (await prisma.user.findUniqueOrThrow({ where: { email: "editor@inventory.local" } })).id;
  const server = await prisma.server.create({ data: { hostname: "grant-guards.example.com", ip: "192.0.2.20", username: "ops" } });
  serverId = server.id;
  await setLicenseTier("pro");
});

afterAll(async () => {
  await restoreLicense();
  await prisma.server.deleteMany({ where: { id: serverId } }); // cascades to its grants
});

const userBody = () => ({ serverId, username: "contractor", expiresAt: inHours(8), onExpiry: "lock", reason: "INC-1" });
const keyBody = () => ({ serverId, username: "deploy", publicKey: KEY, expiresAt: inHours(8), reason: "INC-1" });

describe("unauthenticated", () => {
  it.each([
    ["GET", "", undefined],
    ["GET", "/1", undefined],
    ["POST", "/users", {}],
    ["POST", "/keys", {}],
    ["POST", "/1/extend", {}],
    ["POST", "/1/revoke", {}],
  ] as const)("%s %s → 401", async (method, path, body) => {
    const res = await send(method, path, body);
    expect(res.status).toBe(401);
  });
});

describe("viewer", () => {
  it.each([
    ["GET", ""],
    ["POST", "/users"],
    ["POST", "/keys"],
    ["POST", "/1/extend"],
    ["POST", "/1/revoke"],
  ] as const)("%s %s → 403", async (method, path) => {
    const body = path === "/users" ? userBody() : path === "/keys" ? keyBody() : path.endsWith("extend") ? { expiresAt: inHours(2) } : {};
    const res = await send(method, path, method === "GET" ? undefined : body, viewerCookie);
    expect(res.status).toBe(403);
  });
});

describe("editor privilege guards (before license and SSH)", () => {
  it("a key for root → 403", async () => {
    const res = await send("POST", "/keys", { ...keyBody(), username: "root" }, editorCookie);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toMatch(/server:sudo/);
  });

  it.each([["sudo"], ["docker"], ["wheel"]])("a temporary user in the %s group → 403", async (group) => {
    const res = await send("POST", "/users", { ...userBody(), groups: ["developers", group] }, editorCookie);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toMatch(/server:sudo/);
  });

  it("a temporary user with a sudo rule → 403", async () => {
    const res = await send("POST", "/users", { ...userBody(), sudoType: "all_nopasswd" }, editorCookie);
    expect(res.status).toBe(403);
  });

  it("options in the public key → 400 (validation)", async () => {
    const res = await send("POST", "/keys", { ...keyBody(), publicKey: `command="id" ${KEY}` }, editorCookie);
    expect(res.status).toBe(400);
  });

  it("an expiry beyond 90 days → 400", async () => {
    const res = await send("POST", "/keys", { ...keyBody(), expiresAt: inHours(24 * 91) }, editorCookie);
    expect(res.status).toBe(400);
  });

  it("the free tier refuses creation with 403 after the privilege check passes", async () => {
    await setLicenseTier("free");
    try {
      const res = await send("POST", "/keys", keyBody(), adminCookie);
      expect(res.status).toBe(403);
      expect((await errorOf(res)).message).toMatch(/Time-boxed Access Grants/);
    } finally {
      await setLicenseTier("pro");
    }
  });
});

describe("revoke and extend ownership", () => {
  let adminsGrant = 0;
  let editorsGrant = 0;

  beforeAll(async () => {
    const base = { serverId, kind: "os_user", onExpiry: "lock", reason: "guards", expiresAt: new Date(Date.now() + 3600_000), status: "active" };
    adminsGrant = (await prisma.accessGrant.create({ data: { ...base, username: "adminmade", createdById: adminId } })).id;
    editorsGrant = (await prisma.accessGrant.create({ data: { ...base, username: "editormade", createdById: editorId } })).id;
  });

  it("an editor cannot revoke another user's grant", async () => {
    const res = await send("POST", `/${adminsGrant}/revoke`, {}, editorCookie);
    expect(res.status).toBe(403);
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: adminsGrant } })).status).toBe("active");
  });

  it("an editor cannot extend another user's grant", async () => {
    const res = await send("POST", `/${adminsGrant}/extend`, { expiresAt: inHours(4) }, editorCookie);
    expect(res.status).toBe(403);
  });

  it("the list shows per-caller permissions", async () => {
    const res = await send("GET", `?serverId=${serverId}`, undefined, editorCookie);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { id: number; canRevoke: boolean; canExtend: boolean }[] };
    const mine = items.find((g) => g.id === editorsGrant)!;
    const theirs = items.find((g) => g.id === adminsGrant)!;
    expect(mine).toMatchObject({ canRevoke: true, canExtend: true });
    expect(theirs).toMatchObject({ canRevoke: false, canExtend: false });
  });

  it("the editor's own grant passes the ownership guard (then the state check answers, without SSH)", async () => {
    await prisma.accessGrant.update({ where: { id: editorsGrant }, data: { status: "revoked", revokedAt: new Date() } });
    const res = await send("POST", `/${editorsGrant}/revoke`, {}, editorCookie);
    expect(res.status).toBe(409);
    const ext = await send("POST", `/${editorsGrant}/extend`, { expiresAt: inHours(4) }, editorCookie);
    expect(ext.status).toBe(409);
  });

  it("GET /:id of a missing grant → 404", async () => {
    const res = await send("GET", "/999999", undefined, adminCookie);
    expect(res.status).toBe(404);
  });
});
