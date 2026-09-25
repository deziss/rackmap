import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../db.js";
import { emitAlert } from "../services/alerting/emit.js";
import { dispatchDue } from "../services/alerting/dispatcher.js";
import { isSystemVaultUnlocked, lockVaultGlobal } from "../services/vault.service.js";
import { resetRateLimits } from "../middleware/rate-limit.js";
import { loginAs } from "./helpers.js";
import {
  jsonHeaders,
  LOCAL_POLICY,
  resetAlerts,
  restoreLicense,
  setLicenseTier,
  startReceiver,
  useOutboundPolicy,
  type Receiver,
} from "./alert-test-utils.js";

/**
 * Channel secrets are write-only and v3-encrypted, and the background
 * dispatcher can open them with no operator session and the vault locked.
 */

const app = createApp();
let admin = "";
let editor = "";
let rx: Receiver;

const SECRET_PATH = "T000/B000/SuperSecretToken123";
const HMAC = "hmac-secret-value-0123456789";

beforeAll(async () => {
  admin = await loginAs(app, "admin");
  editor = await loginAs(app, "editor");
  rx = await startReceiver();
  useOutboundPolicy(LOCAL_POLICY);
  await setLicenseTier("pro");
});
afterAll(async () => {
  useOutboundPolicy(null);
  await rx.close();
  await resetAlerts();
  await restoreLicense();
});
beforeEach(async () => {
  await resetAlerts();
  resetRateLimits();
});

async function createWebhook(url: string) {
  const res = await app.request("/api/v1/alert-channels", {
    method: "POST",
    headers: jsonHeaders(admin),
    body: JSON.stringify({ type: "webhook", name: "Ops hook", url, hmacSecret: HMAC, headers: { Authorization: "Bearer hdr-secret-xyz" }, events: ["server_down"] }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<Record<string, any>>;
}

describe("alert channel secrets", () => {
  it("stores the secret as a v3 blob and never returns it", async () => {
    const url = `https://hooks.example.com/services/${SECRET_PATH}`;
    const created = await createWebhook(url);
    const row = await prisma.alertChannel.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.secretEnc?.startsWith("v3.")).toBe(true);
    expect(row.secretEnc).not.toContain(SECRET_PATH);
    expect(row.secretHint).toBe("hooks.example.com/…/n123");

    const bodies = [
      JSON.stringify(created),
      await (await app.request("/api/v1/alert-channels", { headers: jsonHeaders(admin) })).text(),
      await (await app.request(`/api/v1/alert-channels/${created.id}`, { headers: jsonHeaders(admin) })).text(),
      await (await app.request("/api/v1/alert-channels", { headers: jsonHeaders(editor) })).text(),
    ];
    for (const b of bodies) {
      expect(b).not.toContain(SECRET_PATH);
      expect(b).not.toContain(HMAC);
      expect(b).not.toContain("hdr-secret-xyz");
      expect(b).not.toContain("v3.");
    }
    expect(created).toMatchObject({ hasSecret: true, hasHmacSecret: true, headerNames: ["Authorization"] });
  });

  it("keeps the stored secret when PATCH omits it, replaces it when given", async () => {
    const created = await createWebhook(`https://hooks.example.com/services/${SECRET_PATH}`);
    const before = await prisma.alertChannel.findUniqueOrThrow({ where: { id: created.id } });

    const rename = await app.request(`/api/v1/alert-channels/${created.id}`, {
      method: "PATCH",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "webhook", name: "Renamed" }),
    });
    expect(rename.status).toBe(200);
    const mid = await prisma.alertChannel.findUniqueOrThrow({ where: { id: created.id } });
    expect(mid.secretEnc).toBe(before.secretEnc);
    expect(mid.name).toBe("Renamed");

    const replace = await app.request(`/api/v1/alert-channels/${created.id}`, {
      method: "PATCH",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "webhook", url: "https://hooks.example.com/services/NewPath9876", hmacSecret: null }),
    });
    expect(replace.status).toBe(200);
    const after = (await replace.json()) as Record<string, any>;
    expect(after.secretHint).toBe("hooks.example.com/…/9876");
    expect(after.hasHmacSecret).toBe(false);
    expect(after.headerNames).toEqual(["Authorization"]); // untouched
  });

  it("the audit log records the change, never the secret", async () => {
    const created = await createWebhook(`https://hooks.example.com/services/${SECRET_PATH}`);
    const rows = await prisma.auditLog.findMany({ where: { entity: "AlertChannel", entityId: String(created.id) } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const all = `${r.beforeJson ?? ""}${r.afterJson ?? ""}${r.diffJson ?? ""}`;
      expect(all).not.toContain(SECRET_PATH);
      expect(all).not.toContain(HMAC);
    }
  });

  it("the dispatcher delivers with the vault locked and no request session", async () => {
    await createWebhook(`${rx.url}/vault-locked`);
    lockVaultGlobal();
    expect(isSystemVaultUnlocked()).toBe(false);
    await emitAlert({ type: "server_down", severity: "critical", action: "trigger", title: "down", summary: "x" });
    const r = await dispatchDue();
    expect(r.succeeded).toBe(1);
    const got = rx.received.at(-1)!;
    expect(got.path).toBe("/vault-locked");
    expect(got.headers.authorization).toBe("Bearer hdr-secret-xyz");
  });

  it("refuses a reserved header name", async () => {
    const res = await app.request("/api/v1/alert-channels", {
      method: "POST",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "webhook", name: "bad", url: "https://hooks.example.com/x", headers: { "X-Rackmap-Signature": "forged" }, events: ["test"] }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses an SSRF target at save time", async () => {
    useOutboundPolicy({ allowPrivate: false, allowHttp: false, allowlist: [], lookup: async () => [{ address: "10.0.0.8", family: 4 }] });
    try {
      const res = await app.request("/api/v1/alert-channels", {
        method: "POST",
        headers: jsonHeaders(admin),
        body: JSON.stringify({ type: "webhook", name: "internal", url: "https://internal.example.com/hook", events: ["test"] }),
      });
      expect(res.status).toBe(400);
      const meta = await app.request("/api/v1/alert-channels", {
        method: "POST",
        headers: jsonHeaders(admin),
        body: JSON.stringify({ type: "webhook", name: "meta", url: "http://169.254.169.254/latest/meta-data/", events: ["test"] }),
      });
      expect(meta.status).toBe(400);
    } finally {
      useOutboundPolicy(LOCAL_POLICY);
    }
  });
});

describe("test sends", () => {
  it("POST /alert-channels/:id/test sends now and logs a `test` delivery that is never retried", async () => {
    const created = await createWebhook(`${rx.url}/test-send`);
    rx.reply = () => ({ status: 200, body: "ok" });
    const ok = await app.request(`/api/v1/alert-channels/${created.id}/test`, { method: "POST", headers: jsonHeaders(admin) });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, any>;
    expect(okBody).toMatchObject({ ok: true, statusCode: 200, error: null });
    const d = await prisma.alertDelivery.findUniqueOrThrow({ where: { id: okBody.deliveryId }, include: { event: true } });
    expect(d).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(d.event.type).toBe("test");
    expect(rx.received.at(-1)!.headers["x-rackmap-event"]).toBe("test");

    rx.reply = () => ({ status: 500, body: "down" });
    const bad = await app.request(`/api/v1/alert-channels/${created.id}/test`, { method: "POST", headers: jsonHeaders(admin) });
    const badBody = (await bad.json()) as Record<string, any>;
    expect(badBody).toMatchObject({ ok: false, statusCode: 500 });
    const failed = await prisma.alertDelivery.findUniqueOrThrow({ where: { id: badBody.deliveryId } });
    expect(failed.status).toBe("failed");
    // Not left for the dispatcher to retry.
    expect((await dispatchDue()).claimed).toBe(0);
    rx.reply = () => ({ status: 200, body: "ok" });
  });

  it("POST /alert-channels/test sends a draft without writing anything", async () => {
    const before = await prisma.alertDelivery.count();
    const res = await app.request("/api/v1/alert-channels/test", {
      method: "POST",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "webhook", name: "draft", url: `${rx.url}/draft`, events: ["test"] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, any>).ok).toBe(true);
    expect(rx.received.at(-1)!.path).toBe("/draft");
    expect(await prisma.alertDelivery.count()).toBe(before);
    expect(await prisma.alertChannel.count()).toBe(0);
  });

  it("POST /servers/:id/test-alert emits only a `test` event, never a flip", async () => {
    const server = await prisma.server.create({ data: { hostname: "alerts-test-alert", ip: "192.0.2.30", username: "ops" } });
    try {
      await createWebhook(`${rx.url}/server-test`); // subscribed to server_down only
      const testSub = await app.request("/api/v1/alert-channels", {
        method: "POST",
        headers: jsonHeaders(admin),
        body: JSON.stringify({ type: "webhook", name: "tests", url: `${rx.url}/tests`, events: ["test", "server_down"] }),
      });
      expect(testSub.status).toBe(201);

      const res = await app.request(`/api/v1/servers/${server.id}/test-alert`, { method: "POST", headers: jsonHeaders(admin) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.queued).toBe(1);
      const events = await prisma.alertEvent.findMany({});
      expect(events.map((e) => e.type)).toEqual(["test"]);
      expect(events[0]!.action).toBe("info");
      expect(events[0]!.serverId).toBe(server.id);

      const routing = await app.request(`/api/v1/servers/${server.id}/alert-channels`, { headers: jsonHeaders(editor) });
      expect(routing.status).toBe(200);
      const info = (await routing.json()) as Record<string, any>;
      // Both reach this server (server_down); only "tests" got the test alert.
      expect(info.channels.map((c: { name: string }) => c.name).sort()).toEqual(["Ops hook", "tests"]);
      expect(info).toHaveProperty("webhook.configured");
    } finally {
      await prisma.alertDelivery.deleteMany({});
      await prisma.alertEvent.deleteMany({});
      await prisma.server.delete({ where: { id: server.id } });
    }
  });
});
