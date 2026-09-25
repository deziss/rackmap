import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "../db.js";
import { formatters } from "../services/alerting/formatters/index.js";
import { signWebhook, verifyWebhookSignature } from "../services/alerting/formatters/webhook.js";
import { emitAlert } from "../services/alerting/emit.js";
import { dispatchDue } from "../services/alerting/dispatcher.js";
import type { FormatEvent } from "../services/alerting/types.js";
import { insertChannel, LOCAL_POLICY, resetAlerts, restoreLicense, setLicenseTier, startReceiver, type Receiver } from "./alert-test-utils.js";

/** X-Rackmap-Signature: sha256=hex(HMAC(secret, `${timestamp}.${rawBody}`)). */

const SECRET = "whsec_test_0123456789abcdef";

const event: FormatEvent = {
  id: 1,
  type: "heartbeat_fail",
  severity: "error",
  action: "trigger",
  dedupKey: "rackmap:heartbeat:3",
  title: "Heartbeat nightly-backup missed",
  summary: "No ping since 02:00",
  payload: { heartbeatId: 3 },
  serverId: null,
  serviceId: null,
  heartbeatId: 3,
  runbookRunId: null,
  createdAt: new Date("2026-01-02T03:04:00.000Z"),
};

describe("webhook signature", () => {
  it("is sha256 HMAC over `${ts}.${rawBody}`", () => {
    const ts = "1767323045";
    const body = '{"a":1}';
    const expected = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}`;
    expect(signWebhook(SECRET, ts, body)).toBe(expected);
    expect(verifyWebhookSignature(SECRET, ts, body, expected)).toBe(true);
    expect(verifyWebhookSignature(SECRET, ts, '{"a":2}', expected)).toBe(false);
    expect(verifyWebhookSignature(SECRET, "1767323046", body, expected)).toBe(false);
    expect(verifyWebhookSignature("other-secret-value", ts, body, expected)).toBe(false);
  });

  it("the formatter sets event, delivery, timestamp and signature headers", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const req = formatters.webhook.format(event, { id: 1, name: "hook", type: "webhook", config: {} }, { url: "https://hooks.example.com/x", hmacSecret: SECRET }, {
      deliveryId: "99",
      now,
      baseUrl: null,
    });
    if (req.kind !== "http") throw new Error("expected http");
    expect(req.headers["X-Rackmap-Event"]).toBe("heartbeat_fail");
    expect(req.headers["X-Rackmap-Delivery"]).toBe("99");
    expect(req.headers["X-Rackmap-Timestamp"]).toBe(String(Math.floor(now.getTime() / 1000)));
    expect(verifyWebhookSignature(SECRET, req.headers["X-Rackmap-Timestamp"]!, req.body, req.headers["X-Rackmap-Signature"]!)).toBe(true);
    expect(JSON.parse(req.body)).toMatchObject({ version: 1, deliveryId: "99", event: { type: "heartbeat_fail", dedupKey: "rackmap:heartbeat:3" } });
  });

  it("omits the signature when the channel has no secret, and custom headers cannot override ours", () => {
    const req = formatters.webhook.format(
      event,
      { id: 1, name: "hook", type: "webhook", config: {} },
      { url: "https://hooks.example.com/x", headers: { "X-Rackmap-Event": "spoofed", Authorization: "Bearer abc" } },
      { deliveryId: "5", now: new Date(), baseUrl: null },
    );
    if (req.kind !== "http") throw new Error("expected http");
    expect(req.headers["X-Rackmap-Signature"]).toBeUndefined();
    expect(req.headers["X-Rackmap-Event"]).toBe("heartbeat_fail");
    expect(req.headers.Authorization).toBe("Bearer abc");
  });
});

describe("webhook signature end to end", () => {
  let rx: Receiver;
  beforeAll(async () => {
    rx = await startReceiver();
    await setLicenseTier("pro");
  });
  afterAll(async () => {
    await rx.close();
    await resetAlerts();
    await restoreLicense();
  });
  beforeEach(resetAlerts);

  it("a receiver can verify what the dispatcher actually sent", async () => {
    await insertChannel({ type: "webhook", secret: { url: `${rx.url}/signed`, hmacSecret: SECRET }, events: ["heartbeat_fail"] });
    const { queued } = await emitAlert({ type: "heartbeat_fail", severity: "error", action: "trigger", title: "missed", summary: "no ping", heartbeatId: 3 });
    expect(queued).toBe(1);
    const r = await dispatchDue({ policy: LOCAL_POLICY });
    expect(r.succeeded).toBe(1);
    const got = rx.received.at(-1)!;
    const ts = String(got.headers["x-rackmap-timestamp"]);
    expect(verifyWebhookSignature(SECRET, ts, got.body, String(got.headers["x-rackmap-signature"]))).toBe(true);
    const delivery = await prisma.alertDelivery.findFirstOrThrow({});
    expect(got.headers["x-rackmap-delivery"]).toBe(String(delivery.id));
  });
});
