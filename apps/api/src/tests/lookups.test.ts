import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import { prisma } from "../db.js";

const app = createApp();

let adminCookie = "";
let editorCookie = "";
let viewerCookie = "";

beforeAll(async () => {
  [adminCookie, editorCookie, viewerCookie] = await Promise.all([
    loginAs(app, "admin"),
    loginAs(app, "editor"),
    loginAs(app, "viewer"),
  ]);
  // Clean up any test entries from previous runs
  await prisma.cloudProvider.deleteMany({ where: { name: { startsWith: "test-" } } });
});

describe("GET /api/v1/lookups/cloud-providers", () => {
  it("returns 401 if not authenticated", async () => {
    const res = await app.request("/api/v1/lookups/cloud-providers");
    expect(res.status).toBe(401);
  });

  it("viewer can list", async () => {
    const res = await app.request("/api/v1/lookups/cloud-providers", {
      headers: { Cookie: viewerCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 404 for unknown type", async () => {
    const res = await app.request("/api/v1/lookups/invalid-type", {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/lookups/cloud-providers", () => {
  it("returns 401 if not authenticated", async () => {
    const res = await app.request("/api/v1/lookups/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-unauth" }),
    });
    expect(res.status).toBe(401);
  });

  it("viewer cannot create (403)", async () => {
    const res = await app.request("/api/v1/lookups/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      body: JSON.stringify({ name: "test-viewer-create" }),
    });
    expect(res.status).toBe(403);
  });

  it("editor can create (201)", async () => {
    const res = await app.request("/api/v1/lookups/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: editorCookie },
      body: JSON.stringify({ name: "test-editor-domain" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: number; name: string };
    expect(body).toHaveProperty("id");
    expect(body.name).toBe("test-editor-domain");
    // cleanup
    await prisma.cloudProvider.delete({ where: { name: "test-editor-domain" } });
  });

  it("returns 400 for empty name", async () => {
    const res = await app.request("/api/v1/lookups/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate name", async () => {
    // Create one
    await app.request("/api/v1/lookups/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: "test-dup-domain" }),
    });
    // Try to create again
    const res = await app.request("/api/v1/lookups/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: "test-dup-domain" }),
    });
    expect(res.status).toBe(409);
    await prisma.cloudProvider.delete({ where: { name: "test-dup-domain" } });
  });
});

describe("PATCH /api/v1/lookups/cloud-providers/:id", () => {
  it("viewer cannot update (403)", async () => {
    const entry = await prisma.cloudProvider.create({ data: { name: "test-patch-victim" } });
    const res = await app.request(`/api/v1/lookups/cloud-providers/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      body: JSON.stringify({ name: "test-patched" }),
    });
    expect(res.status).toBe(403);
    await prisma.cloudProvider.delete({ where: { id: entry.id } });
  });

  it("editor can update", async () => {
    const entry = await prisma.cloudProvider.create({ data: { name: "test-edit-me" } });
    const res = await app.request(`/api/v1/lookups/cloud-providers/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: editorCookie },
      body: JSON.stringify({ name: "test-edited" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string };
    expect(body.name).toBe("test-edited");
    await prisma.cloudProvider.delete({ where: { id: entry.id } });
  });

  it("returns 404 for missing id", async () => {
    const res = await app.request("/api/v1/lookups/cloud-providers/999999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: "test-ghost" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/lookups/cloud-providers/:id", () => {
  it("editor cannot delete (403)", async () => {
    const entry = await prisma.cloudProvider.create({ data: { name: "test-delete-victim" } });
    const res = await app.request(`/api/v1/lookups/cloud-providers/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: editorCookie },
    });
    expect(res.status).toBe(403);
    await prisma.cloudProvider.delete({ where: { id: entry.id } });
  });

  it("admin can delete unused entry", async () => {
    const entry = await prisma.cloudProvider.create({ data: { name: "test-delete-unused" } });
    const res = await app.request(`/api/v1/lookups/cloud-providers/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
  });

  it("returns 409 when entry has servers", async () => {
    const entry = await prisma.cloudProvider.create({ data: { name: "test-delete-inuse" } });
    const server = await prisma.server.create({
      data: {
        hostname: "test-del-host.local",
        ip: "10.0.0.1",
        username: "root",
        sshPort: 22,
        cloudProviderId: entry.id,
      },
    });
    const res = await app.request(`/api/v1/lookups/cloud-providers/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(409);
    // cleanup
    await prisma.server.delete({ where: { id: server.id } });
    await prisma.cloudProvider.delete({ where: { id: entry.id } });
  });
});
