import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../db.js";
import { emitAlert } from "../services/alerting/emit.js";
import { dispatchDue } from "../services/alerting/dispatcher.js";
import { invalidateAlertLicenseCache } from "../services/alerting/license.js";
import { resetRateLimits } from "../middleware/rate-limit.js";
import { loginAs } from "./helpers.js";
import {
  insertChannel,
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
 * Free tier: env channels + one UI channel (slack/discord/telegram/email/webhook),
 * no filters, no templates. `multi_channel_alerts` lifts it. A lapsed license
 * never deletes anything — deliveries of channels outside the allowance are
 * `suppressed` with a reason.
 */

const app = createApp();
let admin = "";
let rx: Receiver;

const slack = (name: string, extra: Record<string, unknown> = {}) => ({
  type: "slack",
  name,
  url: "https://hooks.slack.com/services/T0/B0/x",
  events: ["server_down"],
  ...extra,
});

async function post(body: unknown) {
  return app.request("/api/v1/alert-channels", { method: "POST", headers: jsonHeaders(admin), body: JSON.stringify(body) });
}

beforeAll(async () => {
  admin = await loginAs(app, "admin");
  rx = await startReceiver();
  useOutboundPolicy({ ...LOCAL_POLICY });
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
  await setLicenseTier("free");
});

describe("alert channel licensing — free tier", () => {
  it("allows one UI channel and refuses a second with 403 NOT_LICENSED", async () => {
    expect((await post(slack("first"))).status).toBe(201);
    const second = await post(slack("second"));
    expect(second.status).toBe(403);
    expect(((await second.json()) as any).error.code).toBe("NOT_LICENSED");
  });

  it("refuses PagerDuty and Teams outright", async () => {
    const pd = await post({ type: "pagerduty", name: "PD", routingKey: "R0123456789abcdef0123456789abcde", events: ["server_down"] });
    expect(pd.status).toBe(403);
    const teams = await post({ type: "teams", name: "Teams", url: "https://prod-01.westus.logic.azure.com/workflows/x", events: ["server_down"] });
    expect(teams.status).toBe(403);
  });

  it("refuses filters and custom templates", async () => {
    expect((await post(slack("filtered", { filters: { environments: ["production"] } }))).status).toBe(403);
    const tpl = await post({
      type: "webhook",
      name: "tpl",
      url: "https://hooks.example.com/x",
      events: ["server_down"],
      config: { format: "template", template: '{"text":"{{event.title}}"}' },
    });
    expect(tpl.status).toBe(403);
  });

  it("refuses a free→pro-feature edit and a draft test of a Pro type", async () => {
    const created = (await (await post(slack("only"))).json()) as { id: number };
    const patch = await app.request(`/api/v1/alert-channels/${created.id}`, {
      method: "PATCH",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "slack", filters: { serverIds: [1] } }),
    });
    expect(patch.status).toBe(403);
    const draft = await app.request("/api/v1/alert-channels/test", {
      method: "POST",
      headers: jsonHeaders(admin),
      body: JSON.stringify({ type: "pagerduty", name: "PD", routingKey: "R0123456789abcdef0123456789abcde", events: ["server_down"] }),
    });
    expect(draft.status).toBe(403);
  });

  it("reports the allowance in the list response", async () => {
    await post(slack("first"));
    const list = (await (await app.request("/api/v1/alert-channels", { headers: jsonHeaders(admin) })).json()) as any;
    expect(list.license).toEqual({ multiChannel: false, uiChannelLimit: 1, uiChannelCount: 1 });
    expect(list.items[0].licensed).toBe(true);
  });
});

describe("alert channel licensing — Pro, then a lapse", () => {
  it("Pro allows PagerDuty, filters and many channels", async () => {
    await setLicenseTier("pro");
    expect((await post(slack("a"))).status).toBe(201);
    expect((await post(slack("b", { filters: { minSeverity: "critical" } }))).status).toBe(201);
    expect((await post({ type: "pagerduty", name: "PD", routingKey: "R0123456789abcdef0123456789abcde", events: ["server_down"] })).status).toBe(201);
  });

  it("after a lapse, deliveries beyond the free allowance are suppressed with a reason", async () => {
    await setLicenseTier("pro");
    const first = await insertChannel({ type: "webhook", secret: { url: `${rx.url}/first` }, events: ["server_down"] });
    const second = await insertChannel({ type: "webhook", secret: { url: `${rx.url}/second` }, events: ["server_down"] });
    const pd = await insertChannel({ type: "pagerduty", secret: { routingKey: "R0123456789abcdef0123456789abcde" }, events: ["server_down"] });
    const env = await insertChannel({ type: "webhook", secret: { url: `${rx.url}/env` }, events: ["server_down"], managedBy: "env", envKey: "NOTIFY_WEBHOOK_URL" });

    await setLicenseTier("free");
    const { queued } = await emitAlert({ type: "server_down", severity: "critical", action: "trigger", title: "down", summary: "x" });
    expect(queued).toBe(2); // the oldest UI channel + the env channel

    const byChannel = async (id: number) => prisma.alertDelivery.findFirstOrThrow({ where: { channelId: id } });
    expect((await byChannel(first.id)).status).toBe("pending");
    expect((await byChannel(env.id)).status).toBe("pending");
    for (const id of [second.id, pd.id]) {
      const d = await byChannel(id);
      expect(d.status).toBe("suppressed");
      expect(d.lastError).toMatch(/^Not licensed/);
    }

    const r = await dispatchDue({ policy: LOCAL_POLICY });
    expect(r.succeeded).toBe(2);
    expect(rx.received.map((x) => x.path).sort()).toEqual(["/env", "/first"]);
  });

  it("a delivery queued while licensed is suppressed if the license lapses before it is sent", async () => {
    await setLicenseTier("pro");
    await insertChannel({ type: "webhook", secret: { url: `${rx.url}/a` }, events: ["server_down"] });
    const late = await insertChannel({ type: "webhook", secret: { url: `${rx.url}/b` }, events: ["server_down"] });
    await emitAlert({ type: "server_down", severity: "critical", action: "trigger", title: "down", summary: "x" });
    expect(await prisma.alertDelivery.count({ where: { status: "pending" } })).toBe(2);

    await setLicenseTier("free");
    invalidateAlertLicenseCache();
    const r = await dispatchDue({ policy: LOCAL_POLICY });
    expect(r.suppressed).toBe(1);
    expect((await prisma.alertDelivery.findFirstOrThrow({ where: { channelId: late.id } })).status).toBe("suppressed");
  });
});
