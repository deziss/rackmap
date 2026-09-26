import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../db.js";
import { syncEnvAlertChannels } from "../services/alert-channel.service.js";
import { openChannelSecret } from "../services/alerting/channel-secret.js";
import { dispatchDue } from "../services/alerting/dispatcher.js";
import { notifyFlip } from "../services/notify.service.js";
import { setOutboundPolicyForTests } from "../lib/outbound-http.js";
import { LEGACY_ENV_ALERT_EVENTS } from "@inv/shared";
import { loginAs } from "./helpers.js";
import { jsonHeaders, resetAlerts, restoreLicense, setLicenseTier, startReceiver, type Receiver } from "./alert-test-utils.js";

/**
 * NOTIFY_WEBHOOK_URL / NOTIFY_TELEGRAM_* become env-managed channels at boot.
 * The sync must be idempotent, follow env changes, and keep the admin's own
 * edits (name, events, enabled); the webhook keeps the exact legacy bodies.
 */

const app = createApp();
let admin = "";

const HOOK = "https://hooks.example.com/legacy/abc123";
const TG = { NOTIFY_TELEGRAM_BOT_TOKEN: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd", NOTIFY_TELEGRAM_CHAT_ID: "-1001234567890" };

beforeAll(async () => {
  admin = await loginAs(app, "admin");
  // Env channels are licensed on every tier; prove it on free.
  await setLicenseTier("free");
});
afterAll(async () => {
  setOutboundPolicyForTests(null);
  await resetAlerts();
  await restoreLicense();
});
beforeEach(resetAlerts);

describe("syncEnvAlertChannels", () => {
  it("creates a legacy_v1 webhook and a telegram channel, idempotently", async () => {
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: HOOK, ...TG });
    const first = await prisma.alertChannel.findMany({ orderBy: { id: "asc" } });
    expect(first).toHaveLength(2);
    const hook = first.find((c) => c.envKey === "NOTIFY_WEBHOOK_URL")!;
    const tg = first.find((c) => c.envKey === "NOTIFY_TELEGRAM")!;
    expect(hook).toMatchObject({ type: "webhook", managedBy: "env", config: { format: "legacy_v1" } });
    expect(hook.events).toEqual(LEGACY_ENV_ALERT_EVENTS);
    expect(tg).toMatchObject({ type: "telegram", managedBy: "env", config: { chatId: TG.NOTIFY_TELEGRAM_CHAT_ID } });
    const hookSecret = openChannelSecret(hook.secretEnc);
    expect(hookSecret.ok && hookSecret.secret.url).toBe(HOOK);
    expect(hook.secretEnc?.startsWith("v3.")).toBe(true);

    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: HOOK, ...TG });
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: HOOK, ...TG });
    const again = await prisma.alertChannel.findMany({ orderBy: { id: "asc" } });
    expect(again.map((c) => [c.id, c.updatedAt.getTime(), c.secretEnc])).toEqual(first.map((c) => [c.id, c.updatedAt.getTime(), c.secretEnc]));
  });

  it("follows an env change but keeps the admin's name, events and enabled", async () => {
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: HOOK });
    const hook = await prisma.alertChannel.findUniqueOrThrow({ where: { envKey: "NOTIFY_WEBHOOK_URL" } });
    await prisma.alertChannel.update({ where: { id: hook.id }, data: { name: "Legacy receiver", events: ["server_down"], enabled: false } });

    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: "https://hooks.example.com/legacy/rotated999" });
    const after = await prisma.alertChannel.findUniqueOrThrow({ where: { envKey: "NOTIFY_WEBHOOK_URL" } });
    expect(after.id).toBe(hook.id);
    expect(after).toMatchObject({ name: "Legacy receiver", events: ["server_down"], enabled: false });
    const s = openChannelSecret(after.secretEnc);
    expect(s.ok && s.secret.url).toBe("https://hooks.example.com/legacy/rotated999");
    expect(after.secretHint).toBe("hooks.example.com/…/d999");
  });

  it("deletes the channel when the variable is unset", async () => {
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: HOOK, ...TG });
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: HOOK });
    expect(await prisma.alertChannel.count({ where: { envKey: "NOTIFY_TELEGRAM" } })).toBe(0);
    await syncEnvAlertChannels({});
    expect(await prisma.alertChannel.count({ where: { managedBy: "env" } })).toBe(0);
  });

  it("does not touch UI channels", async () => {
    await prisma.alertChannel.create({ data: { name: "ui", type: "slack", events: ["test"] } });
    await syncEnvAlertChannels({});
    expect(await prisma.alertChannel.count({ where: { managedBy: "ui" } })).toBe(1);
  });
});

describe("env-managed channels via the API", () => {
  it("DELETE answers 409; PATCH of name/events/enabled works; PATCH of the URL answers 409", async () => {
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: HOOK });
    const hook = await prisma.alertChannel.findUniqueOrThrow({ where: { envKey: "NOTIFY_WEBHOOK_URL" } });

    const del = await app.request(`/api/v1/alert-channels/${hook.id}`, { method: "DELETE", headers: jsonHeaders(admin) });
    expect(del.status).toBe(409);

    const toggle = await app.request(`/api/v1/alert-channels/${hook.id}`, {
      method: "PATCH",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(200);

    const rename = await app.request(`/api/v1/alert-channels/${hook.id}`, {
      method: "PATCH",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "webhook", name: "Old receiver", events: ["server_down", "server_up"], enabled: true }),
    });
    expect(rename.status).toBe(200);

    const url = await app.request(`/api/v1/alert-channels/${hook.id}`, {
      method: "PATCH",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "webhook", url: "https://hooks.example.com/other" }),
    });
    expect(url.status).toBe(409);
  });

  it("env channels do not count against the free tier's one UI channel", async () => {
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: HOOK, ...TG });
    setOutboundPolicyForTests({ allowPrivate: false, allowHttp: false, allowlist: [] });
    const res = await app.request("/api/v1/alert-channels", {
      method: "POST",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "slack", name: "Ops", url: "https://hooks.slack.com/services/T0/B0/x", events: ["server_down"] }),
    });
    expect(res.status).toBe(201);
  });
});

describe("legacy receiver end to end", () => {
  let rx: Receiver;
  beforeAll(async () => {
    rx = await startReceiver();
  });
  afterAll(async () => {
    await rx.close();
  });

  it("an internal http:// NOTIFY_WEBHOOK_URL still works and gets the old body", async () => {
    // Env channels keep private/http access (operator config), even under the strict default policy.
    setOutboundPolicyForTests({ allowPrivate: false, allowHttp: false, allowlist: [] });
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: `${rx.url}/legacy` });
    const flip = { serverId: 12, hostname: "web-01", ip: "192.0.2.10", port: 22, from: "up", to: "down" };
    await notifyFlip(flip);
    const r = await dispatchDue();
    expect(r.succeeded).toBe(1);
    const ev = await prisma.alertEvent.findFirstOrThrow({ orderBy: { id: "desc" } });
    const got = rx.received.at(-1)!;
    expect(got.path).toBe("/legacy");
    expect(got.body).toBe(
      JSON.stringify({
        event: "status_flip",
        type: "server",
        serverId: 12,
        hostname: "web-01",
        ip: "192.0.2.10",
        port: 22,
        from: "up",
        to: "down",
        ts: ev.createdAt.toISOString(),
      }),
    );
  });

  it("env channels still refuse link-local / metadata targets", async () => {
    setOutboundPolicyForTests({ allowPrivate: false, allowHttp: false, allowlist: [] });
    await syncEnvAlertChannels({ NOTIFY_WEBHOOK_URL: "http://169.254.169.254/latest/meta-data/" });
    await notifyFlip({ serverId: 12, hostname: "web-01", ip: "192.0.2.10", port: 22, from: "up", to: "down" });
    const r = await dispatchDue();
    expect(r.failed).toBe(1);
    const d = await prisma.alertDelivery.findFirstOrThrow({});
    expect(d.lastError).toMatch(/^Blocked:/);
  });
});
