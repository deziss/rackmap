import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { OUTBOUND_DNS_TIMEOUT_MS, type OutboundPolicy } from "../lib/outbound-http.js";
import { emitAlert } from "../services/alerting/emit.js";
import { claimLeaseMs, dispatchDue, pruneAlertLog } from "../services/alerting/dispatcher.js";
import { isSystemVaultUnlocked, lockVaultGlobal } from "../services/vault.service.js";
import { insertChannel, LOCAL_POLICY, resetAlerts, restoreLicense, setLicenseTier, startReceiver, type Receiver } from "./alert-test-utils.js";

/**
 * The outbox dispatcher against a local node:http receiver. `now` is passed
 * explicitly so backoff windows are tested without sleeping.
 */

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
beforeEach(async () => {
  await resetAlerts();
  rx.received.length = 0;
  rx.reply = () => ({ status: 200, body: "ok" });
});

async function webhookChannel(path = "/hook", extra: Partial<Parameters<typeof insertChannel>[0]> = {}) {
  return insertChannel({ type: "webhook", secret: { url: `${rx.url}${path}` }, events: ["server_down", "server_up", "test"], ...extra });
}

function downEvent(serverId?: number) {
  return emitAlert({
    type: "server_down",
    severity: "critical",
    action: "trigger",
    dedupKey: `rackmap:server:${serverId ?? 1}`,
    title: "web-01 is DOWN",
    summary: "probe failed",
    serverId: serverId ?? null,
  });
}

/** A receiver that answers 200 only after `delayMs`, recording each X-Rackmap-Delivery id it sees. */
async function startSlowReceiver(delayMs: number) {
  const ids: string[] = [];
  let onRequest: () => void = () => {};
  const server = http.createServer((req, res) => {
    ids.push(String(req.headers["x-rackmap-delivery"]));
    onRequest();
    req.resume();
    setTimeout(() => res.writeHead(200).end("ok"), delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ids,
    onRequest: (fn: () => void) => (onRequest = fn),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function onlyDelivery() {
  const rows = await prisma.alertDelivery.findMany({});
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("alert dispatcher", () => {
  it("retries a 500 with backoff, then succeeds (attempts = 2)", async () => {
    await webhookChannel();
    rx.reply = (_r, n) => (n === 0 ? { status: 500, body: "boom" } : { status: 200, body: "ok" });
    await downEvent();
    const t0 = new Date();

    const first = await dispatchDue({ now: t0, policy: LOCAL_POLICY });
    expect(first).toMatchObject({ claimed: 1, retrying: 1 });
    let d = await onlyDelivery();
    expect(d.status).toBe("retrying");
    expect(d.attempts).toBe(1);
    expect(d.lastStatusCode).toBe(500);
    const wait = d.nextAttemptAt.getTime() - t0.getTime();
    expect(wait).toBeGreaterThanOrEqual(24_000); // 30s −20%
    expect(wait).toBeLessThanOrEqual(36_000); // 30s +20%

    // Not due yet: nothing is claimed.
    expect((await dispatchDue({ now: new Date(t0.getTime() + 10_000), policy: LOCAL_POLICY })).claimed).toBe(0);

    const second = await dispatchDue({ now: new Date(t0.getTime() + 40_000), policy: LOCAL_POLICY });
    expect(second).toMatchObject({ claimed: 1, succeeded: 1 });
    d = await onlyDelivery();
    expect(d.status).toBe("succeeded");
    expect(d.attempts).toBe(2);
    expect(d.sentAt).not.toBeNull();
    expect(d.lockedBy).toBeNull();

    // Same idempotency key on both attempts.
    expect(rx.received).toHaveLength(2);
    expect(rx.received[0]!.headers["x-rackmap-delivery"]).toBe(rx.received[1]!.headers["x-rackmap-delivery"]);
    const ch = await prisma.alertChannel.findFirstOrThrow({});
    expect(ch.consecutiveFailures).toBe(0);
    expect(ch.lastSuccessAt).not.toBeNull();
  });

  it("treats a 400 as permanent: failed after one attempt, channel marked unhealthy", async () => {
    await webhookChannel();
    rx.reply = () => ({ status: 400, body: "invalid_payload" });
    await downEvent();
    const r = await dispatchDue({ policy: LOCAL_POLICY });
    expect(r).toMatchObject({ claimed: 1, failed: 1 });
    const d = await onlyDelivery();
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(1);
    expect(d.lastError).toContain("HTTP 400");
    const ch = await prisma.alertChannel.findFirstOrThrow({});
    expect(ch.consecutiveFailures).toBe(1);
    expect(ch.lastFailureAt).not.toBeNull();
  });

  it("honours Retry-After when it is longer than the backoff", async () => {
    await webhookChannel();
    rx.reply = () => ({ status: 429, headers: { "retry-after": "600" } });
    await downEvent();
    const t0 = new Date();
    await dispatchDue({ now: t0, policy: LOCAL_POLICY });
    const d = await onlyDelivery();
    expect(d.status).toBe("retrying");
    expect(d.nextAttemptAt.getTime() - t0.getTime()).toBeGreaterThanOrEqual(600_000);
  });

  it("gives up after maxAttempts retryable failures", async () => {
    await webhookChannel();
    rx.reply = () => ({ status: 503 });
    await downEvent();
    let now = new Date();
    for (let i = 0; i < 6; i++) {
      await dispatchDue({ now, policy: LOCAL_POLICY });
      now = new Date(now.getTime() + 3 * 60 * 60 * 1000 + 1); // past the longest backoff (2h +20%)
      await prisma.alertEvent.updateMany({ data: { createdAt: new Date(now.getTime() - 1000) } }); // keep it fresh
    }
    const d = await onlyDelivery();
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(6);
    expect(rx.received).toHaveLength(6);
  });

  it("two concurrent dispatchers with different holders deliver exactly once", async () => {
    await webhookChannel();
    await downEvent();
    const now = new Date();
    const [a, b] = await Promise.all([
      dispatchDue({ holder: "replica-a", now, policy: LOCAL_POLICY }),
      dispatchDue({ holder: "replica-b", now, policy: LOCAL_POLICY }),
    ]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(rx.received).toHaveLength(1);
    expect((await onlyDelivery()).status).toBe("succeeded");
  });

  it("re-claims a row whose sender died mid-send (expired lock)", async () => {
    await webhookChannel();
    await downEvent();
    const d0 = await onlyDelivery();
    await prisma.alertDelivery.update({
      where: { id: d0.id },
      data: { status: "sending", lockedBy: "dead-replica", lockedUntil: new Date(Date.now() - 1000) },
    });
    const r = await dispatchDue({ holder: "replica-b", policy: LOCAL_POLICY });
    expect(r.succeeded).toBe(1);
  });

  it("does not steal a live claim", async () => {
    await webhookChannel();
    await downEvent();
    const d0 = await onlyDelivery();
    await prisma.alertDelivery.update({
      where: { id: d0.id },
      data: { status: "sending", lockedBy: "busy-replica", lockedUntil: new Date(Date.now() + 60_000) },
    });
    expect((await dispatchDue({ holder: "replica-b", policy: LOCAL_POLICY })).claimed).toBe(0);
    expect(rx.received).toHaveLength(0);
  });

  it("claims lazily: a batch that outlasts the lease is never sent twice across two replicas", async () => {
    // 20 rows at concurrency 5 and 200ms per send take ~800ms, but each lease is
    // 500ms. Claiming the whole batch up front would let replica-b (ticking once
    // replica-a is already sending) reclaim the tail while replica-a still has it
    // queued or in flight, and both would send it.
    const slow = await startSlowReceiver(200);
    const firstSend = new Promise<void>((resolve) => slow.onRequest(resolve));
    try {
      for (const path of ["/a", "/b"]) {
        await insertChannel({ type: "webhook", secret: { url: `${slow.url}${path}` }, events: ["server_down"] });
      }
      for (let i = 0; i < 10; i++) await downEvent();
      expect(await prisma.alertDelivery.count()).toBe(20);

      let aDone = false;
      const a = dispatchDue({ holder: "replica-a", policy: LOCAL_POLICY, leaseMs: 500 }).finally(() => (aDone = true));
      await firstSend;
      let bClaimed = 0;
      while (!aDone) {
        bClaimed += (await dispatchDue({ holder: "replica-b", policy: LOCAL_POLICY, leaseMs: 500 })).claimed;
        await new Promise((r) => setTimeout(r, 25));
      }
      const aClaimed = (await a).claimed;

      expect(aClaimed + bClaimed).toBe(20);
      expect(slow.ids).toHaveLength(20);
      expect(new Set(slow.ids).size).toBe(20);
      const rows = await prisma.alertDelivery.findMany({});
      expect(rows.filter((d) => d.status === "succeeded" && d.attempts === 1 && d.lockedBy === null)).toHaveLength(20);
    } finally {
      await slow.close();
    }
  });

  it("holds each claim for longer than one worst-case send (DNS + request timeout)", async () => {
    expect(claimLeaseMs()).toBeGreaterThan(OUTBOUND_DNS_TIMEOUT_MS + env.ALERT_OUTBOUND_TIMEOUT_MS);
    const slow = await startSlowReceiver(100);
    try {
      await insertChannel({ type: "webhook", secret: { url: `${slow.url}/hook` }, events: ["server_down"] });
      await downEvent();
      let lockedUntil: Date | null = null;
      slow.onRequest(() => void prisma.alertDelivery.findFirst({}).then((d) => (lockedUntil = d?.lockedUntil ?? null)));
      const before = Date.now();
      await dispatchDue({ policy: LOCAL_POLICY });
      expect(lockedUntil).not.toBeNull();
      expect(lockedUntil!.getTime()).toBeGreaterThanOrEqual(before + claimLeaseMs());
    } finally {
      await slow.close();
    }
  });

  it("logs a lease lost mid-send and leaves the new holder's claim alone", async () => {
    const slow = await startSlowReceiver(150);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await insertChannel({ type: "webhook", secret: { url: `${slow.url}/hook` }, events: ["server_down"] });
      await downEvent();
      // Another replica takes the row over while replica-a waits on the receiver.
      // (Prisma queries are lazy: `.then` is what actually runs this one.)
      slow.onRequest(() => void prisma.alertDelivery.updateMany({ data: { lockedBy: "replica-z" } }).then(() => {}));
      expect((await dispatchDue({ holder: "replica-a", policy: LOCAL_POLICY })).claimed).toBe(1);
      const d = await onlyDelivery();
      expect(d.status).toBe("sending");
      expect(d.lockedBy).toBe("replica-z");
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/delivery \d+: lease lost before recording "succeeded"/));
    } finally {
      warn.mockRestore();
      await slow.close();
    }
  });

  it("bounds the DNS lookup: a resolver that never answers is a retryable timeout", async () => {
    await insertChannel({ type: "webhook", secret: { url: "http://hooks.example.com/hook" }, events: ["server_down"] });
    await downEvent();
    const hung: OutboundPolicy = { ...LOCAL_POLICY, lookup: () => new Promise(() => {}), lookupTimeoutMs: 50 };
    const r = await dispatchDue({ policy: hung });
    expect(r).toMatchObject({ claimed: 1, retrying: 1 });
    const d = await onlyDelivery();
    expect(d.status).toBe("retrying");
    expect(d.lastError).toBe("DNS lookup timed out after 50ms");
    expect(rx.received).toHaveLength(0);
  });

  it("delivers with the vault locked and no request session (v3 secret)", async () => {
    lockVaultGlobal();
    expect(isSystemVaultUnlocked()).toBe(false);
    const ch = await webhookChannel();
    expect(ch.secretEnc?.startsWith("v3.")).toBe(true);
    await downEvent();
    const r = await dispatchDue({ policy: LOCAL_POLICY });
    expect(r.succeeded).toBe(1);
    expect(rx.received).toHaveLength(1);
  });

  it("expires events older than ALERT_MAX_EVENT_AGE_MS instead of sending them late", async () => {
    await webhookChannel();
    await downEvent();
    const r = await dispatchDue({ now: new Date(Date.now() + 7 * 60 * 60 * 1000), policy: LOCAL_POLICY });
    expect(r.expired).toBe(1);
    expect((await onlyDelivery()).status).toBe("expired");
    expect(rx.received).toHaveLength(0);
  });

  it("suppresses deliveries for a channel disabled after the event was queued", async () => {
    const ch = await webhookChannel();
    await downEvent();
    await prisma.alertChannel.update({ where: { id: ch.id }, data: { enabled: false } });
    const r = await dispatchDue({ policy: LOCAL_POLICY });
    expect(r.suppressed).toBe(1);
    expect(rx.received).toHaveLength(0);
  });

  it("refuses a destination the policy blocks, permanently and without sending", async () => {
    await webhookChannel();
    await downEvent();
    const r = await dispatchDue({ policy: { allowPrivate: false, allowHttp: true, allowlist: [] } });
    expect(r.failed).toBe(1);
    const d = await onlyDelivery();
    expect(d.lastError).toMatch(/^Blocked:/);
    expect(d.lastError).not.toContain("127.0.0.1");
    expect(rx.received).toHaveLength(0);
  });

  it("rate-limits one channel to ~20/min and defers the rest without counting an attempt", async () => {
    await webhookChannel();
    for (let i = 0; i < 22; i++) await downEvent();
    const now = new Date();
    const r = await dispatchDue({ now, limit: 50, policy: LOCAL_POLICY });
    expect(r.succeeded).toBe(20);
    expect(r.deferred).toBe(2);
    const deferred = await prisma.alertDelivery.findMany({ where: { status: "pending" } });
    expect(deferred).toHaveLength(2);
    for (const d of deferred) {
      expect(d.attempts).toBe(0);
      expect(d.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("fans out only to subscribed channels that pass their filters", async () => {
    const s1 = await prisma.server.create({ data: { hostname: "alerts-filter-a", ip: "192.0.2.21", username: "ops", environment: "production" } });
    const s2 = await prisma.server.create({ data: { hostname: "alerts-filter-b", ip: "192.0.2.22", username: "ops", environment: "staging" } });
    try {
      const prodOnly = await webhookChannel("/prod", { filters: { environments: ["production"] } });
      const all = await webhookChannel("/all");
      const upOnly = await webhookChannel("/up", { events: ["server_up"] });
      const critOnly = await webhookChannel("/crit", { filters: { minSeverity: "critical" } });

      await downEvent(s1.id);
      await downEvent(s2.id);
      await emitAlert({ type: "server_up", severity: "info", action: "resolve", dedupKey: `rackmap:server:${s2.id}`, title: "up", summary: "", serverId: s2.id });

      const count = async (channelId: number) => prisma.alertDelivery.count({ where: { channelId } });
      expect(await count(prodOnly.id)).toBe(1); // only s1's down
      expect(await count(all.id)).toBe(3);
      expect(await count(upOnly.id)).toBe(1);
      expect(await count(critOnly.id)).toBe(3); // resolves pass minSeverity
    } finally {
      await prisma.alertDelivery.deleteMany({});
      await prisma.server.deleteMany({ where: { id: { in: [s1.id, s2.id] } } });
    }
  });

  it("prunes events (and their deliveries) past the retention window", async () => {
    await webhookChannel();
    await downEvent();
    await prisma.alertEvent.updateMany({ data: { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) } });
    expect(await pruneAlertLog()).toBe(1);
    expect(await prisma.alertDelivery.count()).toBe(0);
  });
});
