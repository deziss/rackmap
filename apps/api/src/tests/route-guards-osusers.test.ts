import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import { prisma } from "../db.js";

// OS-user writes are a Pro feature (remote_os_users). Tests switch the tier by
// writing the single system_license row and put the original back afterwards.
let savedLicense: Awaited<ReturnType<typeof prisma.systemLicense.findFirst>> | undefined;

async function setLicenseTier(tier: "free" | "pro"): Promise<void> {
  if (savedLicense === undefined) savedLicense = await prisma.systemLicense.findFirst({ where: { id: 1 } });
  if (tier === "free") {
    await prisma.systemLicense.deleteMany({ where: { id: 1 } });
    return;
  }
  const data = { key: "LIC-TEST-OSUSERS-PRO-0001", tier: "pro", maxServers: -1, featuresJson: "{}", expiresAt: null };
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

/**
 * Privilege-escalation guard on the OS-user routes.
 *
 * server:osUsers (editor) lets a caller manage accounts, but a sudo grant or a
 * root-equivalent group is a privilege grant and needs the admin-only
 * server:sudo. The refusal must happen on the request body alone, before the
 * license check and before any SSH connection — so the server id here does
 * not exist and the outcome is still deterministic.
 */

const app = createApp();
const MISSING_SERVER = 999_999;
const PRIVILEGE_MESSAGE = /server:sudo/;

let adminCookie = "";
let editorCookie = "";
let viewerCookie = "";

beforeAll(async () => {
  adminCookie = await loginAs(app, "admin");
  editorCookie = await loginAs(app, "editor");
  viewerCookie = await loginAs(app, "viewer");
});

function send(method: string, path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const createPath = `/api/v1/servers/${MISSING_SERVER}/os-users`;
const updatePath = `/api/v1/servers/${MISSING_SERVER}/os-users/alice`;

type Case = { name: string; method: "POST" | "PATCH"; path: string; body: Record<string, unknown> };

const PRIVILEGED: Case[] = [
  { name: "create with sudoType all_nopasswd", method: "POST", path: createPath, body: { username: "alice", sudoType: "all_nopasswd" } },
  { name: "create with sudoType all_passwd", method: "POST", path: createPath, body: { username: "alice", sudoType: "all_passwd" } },
  {
    name: "create with a custom sudo rule",
    method: "POST",
    path: createPath,
    body: { username: "alice", sudoType: "custom", customCommands: ["/usr/bin/systemctl restart nginx"] },
  },
  { name: "create in the docker group", method: "POST", path: createPath, body: { username: "alice", groups: ["docker"] } },
  { name: "create in the sudo group", method: "POST", path: createPath, body: { username: "alice", groups: ["developers", "sudo"] } },
  { name: "update into the lxd group", method: "PATCH", path: updatePath, body: { groups: ["lxd"] } },
  { name: "update with sudoType all_nopasswd", method: "PATCH", path: updatePath, body: { sudoType: "all_nopasswd" } },
];

describe("OS-user privilege grants require server:sudo", () => {
  it.each(PRIVILEGED)("rejects an unauthenticated caller: $name", async (c) => {
    const res = await send(c.method, c.path, c.body);
    expect(res.status).toBe(401);
  });

  it.each(PRIVILEGED)("rejects a viewer: $name", async (c) => {
    const res = await send(c.method, c.path, c.body, viewerCookie);
    expect(res.status).toBe(403);
  });

  it.each(PRIVILEGED)("rejects an editor with FORBIDDEN before any SSH work: $name", async (c) => {
    const res = await send(c.method, c.path, c.body, editorCookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toMatch(PRIVILEGE_MESSAGE);
  });

  it("does not trip the privilege guard for a plain editor create", async () => {
    const res = await send("POST", createPath, { username: "alice", sudoType: "none", groups: ["developers"] }, editorCookie);
    // Whatever happens next (license gate, missing server), it is not this guard.
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").not.toMatch(PRIVILEGE_MESSAGE);
  });

  it("does not trip the privilege guard for an admin", async () => {
    const res = await send("POST", createPath, { username: "alice", sudoType: "all_nopasswd" }, adminCookie);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").not.toMatch(PRIVILEGE_MESSAGE);
  });

  describe("with a Pro license", () => {
    beforeAll(() => setLicenseTier("pro"));
    afterAll(() => restoreLicense());

    it("a plain editor update reaches the service (missing server → 404, not the guard)", async () => {
      const res = await send("PATCH", updatePath, { shell: "/bin/bash" }, editorCookie);
      expect(res.status).toBe(404);
    });
  });
});

describe("OS-user update and delete need the remote_os_users license feature", () => {
  beforeAll(() => setLicenseTier("free"));
  afterAll(() => restoreLicense());

  it("PATCH on the free tier is refused before any SSH", async () => {
    const res = await send("PATCH", updatePath, { shell: "/bin/bash" }, adminCookie);
    expect(res.status).toBe(403);
  });

  it("DELETE on the free tier is refused before any SSH", async () => {
    const res = await app.request(`${updatePath}?removeHome=true&force=false`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE os-user accepts query-string booleans (A1 regression)", () => {
  beforeAll(() => setLicenseTier("pro"));
  afterAll(() => restoreLicense());

  it("removeHome=true&force=false passes validation and reaches the service", async () => {
    const res = await app.request(`${updatePath}?removeHome=true&force=false`, {
      method: "DELETE",
      headers: { Cookie: editorCookie },
    });
    // Before the fix this was a 400 from the query validator on every call.
    // Now it gets as far as looking the server up.
    expect(res.status).toBe(404);
  });
});
