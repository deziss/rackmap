import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import { prisma } from "../db.js";

/**
 * Without these routes, migrating to SSH_HOST_POLICY=tofu means reading the
 * pin store with sqlite3, and every legitimate reimage means deleting a row by
 * hand. Forgetting a pin is security-relevant — the next connection trusts
 * whatever answers — so it must stay admin-gated and audited.
 */

const app = createApp();

let adminCookie = "";
let editorCookie = "";
let viewerCookie = "";

const HOSTS = ["10.255.0.1", "10.255.0.2", "10.255.0.3"];

beforeAll(async () => {
  [adminCookie, editorCookie, viewerCookie] = await Promise.all([
    loginAs(app, "admin"),
    loginAs(app, "editor"),
    loginAs(app, "viewer"),
  ]);
});

afterEach(async () => {
  await prisma.sshHostKey.deleteMany({ where: { host: { in: HOSTS } } });
});

async function pin(host: string, fingerprint = "SHA256:AAAAtestfingerprint") {
  return prisma.sshHostKey.create({
    data: { host, port: 22, keyType: "ssh-ed25519", fingerprint, publicKey: "AAAAC3Nz" },
  });
}

describe("GET /api/v1/ssh-host-keys", () => {
  it("rejects an unauthenticated caller", async () => {
    const res = await app.request("/api/v1/ssh-host-keys");
    expect(res.status).toBe(401);
  });

  it("rejects a viewer", async () => {
    const res = await app.request("/api/v1/ssh-host-keys", { headers: { Cookie: viewerCookie } });
    expect(res.status).toBe(403);
  });

  it("lists pinned endpoints for an editor", async () => {
    await pin(HOSTS[0]!);
    const res = await app.request("/api/v1/ssh-host-keys", { headers: { Cookie: editorCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const mine = body.items.filter((k) => HOSTS.includes(k["host"] as string));
    expect(mine).toHaveLength(1);
    expect(mine[0]!["fingerprint"]).toBe("SHA256:AAAAtestfingerprint");
  });

  it("flags one key presented by several endpoints", async () => {
    await pin(HOSTS[0]!, "SHA256:shared");
    await pin(HOSTS[1]!, "SHA256:shared");
    await pin(HOSTS[2]!, "SHA256:unique");

    const res = await app.request("/api/v1/ssh-host-keys", { headers: { Cookie: adminCookie } });
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const byHost = new Map(body.items.map((k) => [k["host"], k]));

    expect(byHost.get(HOSTS[0])?.["sharedWithOtherEndpoints"]).toBe(true);
    expect(byHost.get(HOSTS[1])?.["sharedWithOtherEndpoints"]).toBe(true);
    expect(byHost.get(HOSTS[2])?.["sharedWithOtherEndpoints"]).toBe(false);
  });

  it("filters by fingerprint", async () => {
    await pin(HOSTS[0]!, "SHA256:wanted");
    await pin(HOSTS[1]!, "SHA256:other");

    const res = await app.request("/api/v1/ssh-host-keys?fingerprint=SHA256:wanted", {
      headers: { Cookie: adminCookie },
    });
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items.every((k) => k["fingerprint"] === "SHA256:wanted")).toBe(true);
    expect(body.items.some((k) => k["host"] === HOSTS[0])).toBe(true);
  });

  it("never returns the raw public key blob", async () => {
    await pin(HOSTS[0]!);
    const res = await app.request("/api/v1/ssh-host-keys", { headers: { Cookie: adminCookie } });
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    for (const k of body.items) expect(k).not.toHaveProperty("publicKey");
  });
});

describe("DELETE /api/v1/ssh-host-keys/:id", () => {
  it("rejects a viewer and an editor", async () => {
    const row = await pin(HOSTS[0]!);
    for (const cookie of [viewerCookie, editorCookie]) {
      const res = await app.request(`/api/v1/ssh-host-keys/${row.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(403);
    }
    expect(await prisma.sshHostKey.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it("lets an admin forget a pin, and records the forgotten fingerprint", async () => {
    const row = await pin(HOSTS[0]!, "SHA256:tobeforgotten");

    const res = await app.request(`/api/v1/ssh-host-keys/${row.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    expect(await prisma.sshHostKey.findUnique({ where: { id: row.id } })).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: "ssh_host_key.forget", entityId: String(row.id) },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    // The old fingerprint is the thing an investigator needs afterwards.
    expect(audit?.beforeJson).toContain("SHA256:tobeforgotten");
  });

  it("404s on an unknown id", async () => {
    const res = await app.request("/api/v1/ssh-host-keys/99999999", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(404);
  });

  it("400s on a malformed id", async () => {
    const res = await app.request("/api/v1/ssh-host-keys/not-a-number", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(400);
  });
});
