import pLimit from "p-limit";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { INSTANCE_ID, withJobLock } from "../job-lock.service.js";
import { OUTBOUND_DNS_TIMEOUT_MS, type OutboundPolicy } from "../../lib/outbound-http.js";
import { openChannelSecret } from "./channel-secret.js";
import { formatterFor } from "./formatters/index.js";
import { sanitizeError } from "./formatters/common.js";
import { getLicensedChannelIds, isLicensed, UNLICENSED_REASON } from "./license.js";
import { policyForChannel, publicBaseUrl, sendFormatted, toFormatChannel, toFormatEvent } from "./send.js";

/**
 * Alert outbox dispatcher: sends AlertDelivery rows, from any replica.
 *
 * Claiming is per row, lazy and optimistic — no global lock. A replica reads a
 * batch of due ids, then each send worker, immediately before sending a row,
 * issues
 *
 *   UPDATE alert_delivery SET status='sending', lockedBy=me, lockedUntil=clock+lease
 *    WHERE id=? AND status=<what I saw> AND nextAttemptAt<=now [AND lockedUntil=<what I saw>]
 *
 * and only sends if that touched exactly one row. Two replicas racing for the
 * same row serialize on its row lock; the loser's predicate no longer matches.
 * The lease starts at the claim, not when the batch was read, and outlasts one
 * worst-case send (DNS timeout + request timeout + margin). Claiming the whole
 * batch up front instead let the tail's leases run out while those rows were
 * still queued here, so another replica reclaimed and sent them as well.
 * A replica that dies mid-send leaves `sending` with an expired lockedUntil,
 * which makes the row claimable again (at-least-once, and the webhook
 * X-Rackmap-Delivery id lets receivers drop the duplicate).
 *
 * Every write after the claim is conditional on still holding it
 * (`lockedBy=me AND status='sending'`), so a replica whose lease was taken
 * over cannot clobber the new holder's result.
 *
 * Retries: backoff [0, 30s, 2m, 10m, 30m, 2h] with ±20% jitter, never sooner
 * than a Retry-After (header, Telegram `parameters.retry_after`, Discord
 * `retry_after`). 4xx other than 408/429 is permanent. Events older than
 * ALERT_MAX_EVENT_AGE_MS expire instead of arriving hours late.
 *
 * A per-channel token bucket (20/min) spreads a fleet-wide outage out instead
 * of getting the channel 429'd; deferral does not count as an attempt.
 *
 * The loop is started from index.ts only (gated by ALERT_DISPATCH_ENABLED),
 * never by createApp(): tests call dispatchDue() directly with a fixed `now`.
 */

const MIN_CLAIM_MS = 60_000;
const CLAIM_MARGIN_MS = 30_000;
const BATCH_SIZE = 50;
const SEND_CONCURRENCY = 5;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 1_800_000, 7_200_000] as const;

const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_PER_MS = 20 / 60_000;
const buckets = new Map<number, { tokens: number; at: number }>();

/** Take one send token for a channel. Returns 0 when taken, else ms until one is available. */
function takeToken(channelId: number, nowMs: number): number {
  const b = buckets.get(channelId) ?? { tokens: BUCKET_CAPACITY, at: nowMs };
  b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + Math.max(0, nowMs - b.at) * BUCKET_REFILL_PER_MS);
  b.at = nowMs;
  buckets.set(channelId, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return 0;
  }
  return Math.ceil((1 - b.tokens) / BUCKET_REFILL_PER_MS);
}

/** Test-only: forget all per-channel send budgets. */
export function resetAlertRateBuckets(): void {
  buckets.clear();
}

/**
 * How long one claim holds a row: a worst-case send (DNS timeout, then the
 * request timeout) plus a margin for the surrounding DB round trips.
 */
export function claimLeaseMs(): number {
  return Math.max(MIN_CLAIM_MS, OUTBOUND_DNS_TIMEOUT_MS + env.ALERT_OUTBOUND_TIMEOUT_MS + CLAIM_MARGIN_MS);
}

/** Delay before retry number `attemptsSoFar` (1 = after the first failure), jittered ±20%. */
export function backoffDelay(attemptsSoFar: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(attemptsSoFar, BACKOFF_MS.length - 1)]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface DispatchOptions {
  holder?: string;
  now?: Date;
  limit?: number;
  /** Outbound policy override (tests allow 127.0.0.1). */
  policy?: OutboundPolicy;
  /** Claim lease override (tests use a short one); defaults to claimLeaseMs(). */
  leaseMs?: number;
}

export interface DispatchResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  deferred: number;
  expired: number;
  suppressed: number;
}

/** Claim due deliveries and send them. Safe to run concurrently on every replica. */
export async function dispatchDue(opts: DispatchOptions = {}): Promise<DispatchResult> {
  const holder = opts.holder ?? INSTANCE_ID;
  // Tests pin `now`; otherwise each row reads the clock when its turn comes.
  const clock = () => opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? claimLeaseMs();
  const now = clock();
  const result: DispatchResult = { claimed: 0, succeeded: 0, retrying: 0, failed: 0, deferred: 0, expired: 0, suppressed: 0 };

  const due = await prisma.alertDelivery.findMany({
    where: {
      nextAttemptAt: { lte: now },
      OR: [{ status: { in: ["pending", "retrying"] } }, { status: "sending", lockedUntil: { lt: now } }],
    },
    select: { id: true, status: true, lockedUntil: true },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: opts.limit ?? BATCH_SIZE,
  });

  let licensed: ReturnType<typeof getLicensedChannelIds> | undefined;
  const limit = pLimit(SEND_CONCURRENCY);
  const outcomes = await Promise.all(
    due.map((d) =>
      limit(async (): Promise<Outcome> => {
        // Claim only now that a worker is free: `d` may be stale, and the predicate re-checks it.
        const at = clock();
        const { count } = await prisma.alertDelivery.updateMany({
          where: {
            id: d.id,
            status: d.status,
            nextAttemptAt: { lte: at },
            ...(d.status === "sending" ? { lockedUntil: d.lockedUntil } : {}),
          },
          // Wall clock, not `at`: the lease must cover the real send even when a test pins `now`.
          data: { status: "sending", lockedBy: holder, lockedUntil: new Date(Date.now() + leaseMs) },
        });
        if (count !== 1) return "lost";
        result.claimed += 1;
        licensed ??= getLicensedChannelIds();
        return deliverClaimed(d.id, holder, at, await licensed, opts.policy);
      }),
    ),
  );
  for (const o of outcomes) if (o !== "lost") result[o] += 1;
  return result;
}

type Outcome = "succeeded" | "retrying" | "failed" | "deferred" | "expired" | "suppressed" | "lost";

async function deliverClaimed(
  id: number,
  holder: string,
  now: Date,
  licensed: Awaited<ReturnType<typeof getLicensedChannelIds>>,
  policyOverride?: OutboundPolicy,
): Promise<Outcome> {
  const d = await prisma.alertDelivery.findUnique({ where: { id }, include: { event: true, channel: true } });
  if (!d || d.lockedBy !== holder || d.status !== "sending") return "lost";

  const finalize = async (data: Record<string, unknown>) => {
    const { count } = await prisma.alertDelivery.updateMany({
      where: { id, lockedBy: holder, status: "sending" },
      data: { ...data, lockedBy: null, lockedUntil: null },
    });
    if (count !== 1) {
      // The lease ran out mid-delivery and another replica took the row over; its result stands.
      console.warn(`[alerts] delivery ${id}: lease lost before recording "${String(data.status)}"; another replica owns it now`);
    }
    return count === 1;
  };

  try {
    if (now.getTime() - d.event.createdAt.getTime() > env.ALERT_MAX_EVENT_AGE_MS) {
      await finalize({ status: "expired", lastError: "Event is older than ALERT_MAX_EVENT_AGE_MS; not sent" });
      return "expired";
    }
    if (!d.channel.enabled) {
      await finalize({ status: "suppressed", lastError: "Channel is disabled" });
      return "suppressed";
    }
    if (!isLicensed(licensed, d.channelId)) {
      await finalize({ status: "suppressed", lastError: UNLICENSED_REASON });
      return "suppressed";
    }

    const formatter = formatterFor(d.channel.type);
    if (!formatter) {
      await finalize({ status: "failed", lastError: `Unknown channel type "${d.channel.type}"` });
      return "failed";
    }
    const opened = openChannelSecret(d.channel.secretEnc);
    if (!opened.ok) {
      await finalize({ status: "failed", attempts: d.attempts + 1, lastError: opened.reason });
      await recordChannelHealth(d.channelId, false, opened.reason);
      return "failed";
    }

    const wait = takeToken(d.channelId, now.getTime());
    if (wait > 0) {
      await finalize({ status: d.attempts > 0 ? "retrying" : "pending", nextAttemptAt: new Date(now.getTime() + wait) });
      return "deferred";
    }

    let req;
    try {
      req = formatter.format(toFormatEvent(d.event), toFormatChannel(d.channel), opened.secret, {
        deliveryId: String(d.id),
        now,
        baseUrl: publicBaseUrl(),
      });
    } catch (err) {
      const msg = sanitizeError(`Could not build the message: ${(err as Error).message}`);
      await finalize({ status: "failed", attempts: d.attempts + 1, lastError: msg });
      await recordChannelHealth(d.channelId, false, msg);
      return "failed";
    }
    if (req.kind === "skip") {
      await finalize({ status: "suppressed", lastError: req.reason });
      return "suppressed";
    }

    const policy = policyForChannel(d.channel, policyOverride);
    const out = await sendFormatted(req, formatter, policy, now);
    const attempts = d.attempts + 1;

    if (out.ok) {
      await finalize({ status: "succeeded", attempts, sentAt: new Date(), lastStatusCode: out.statusCode, lastError: null });
      await recordChannelHealth(d.channelId, true, null);
      return "succeeded";
    }

    await recordChannelHealth(d.channelId, false, out.error);
    if (out.retryable && attempts < d.maxAttempts) {
      const delay = Math.max(backoffDelay(attempts), out.retryAfterMs ?? 0);
      await finalize({
        status: "retrying",
        attempts,
        nextAttemptAt: new Date(now.getTime() + delay),
        lastStatusCode: out.statusCode,
        lastError: out.error,
      });
      return "retrying";
    }
    await finalize({ status: "failed", attempts, lastStatusCode: out.statusCode, lastError: out.error });
    return "failed";
  } catch (err) {
    // Unexpected (DB hiccup mid-delivery): release the claim for a later retry.
    console.error(`[alerts] delivery ${id} crashed:`, (err as Error).message);
    await finalize({
      status: "retrying",
      nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[1]),
      lastError: sanitizeError((err as Error).message ?? "internal error"),
    }).catch(() => {});
    return "retrying";
  }
}

/** Health for the "failing" badge. Channels are never auto-disabled. */
export async function recordChannelHealth(channelId: number, ok: boolean, error: string | null): Promise<void> {
  if (ok) {
    await prisma.alertChannel.updateMany({
      where: { id: channelId },
      data: { consecutiveFailures: 0, lastSuccessAt: new Date(), lastError: null },
    });
  } else {
    await prisma.alertChannel.updateMany({
      where: { id: channelId },
      data: { consecutiveFailures: { increment: 1 }, lastFailureAt: new Date(), lastError: error?.slice(0, 1000) ?? null },
    });
  }
}

/** Delete events (and, by cascade, their deliveries) older than ALERT_DELIVERY_RETENTION_DAYS. */
export async function pruneAlertLog(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.ALERT_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.alertEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

// ─── Loop ────────────────────────────────────────────────────────────────────

let started = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function schedule(ms: number) {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
  timer.unref?.();
}

async function tick() {
  if (!started) return;
  if (running) return schedule(env.ALERT_DISPATCH_INTERVAL_MS);
  running = true;
  let more = false;
  try {
    const r = await dispatchDue();
    // A full batch means there is likely more waiting: go again right away.
    more = r.claimed >= BATCH_SIZE;
  } catch (err) {
    console.error("[alerts] dispatch tick failed:", (err as Error).message);
  } finally {
    running = false;
    schedule(more ? 0 : env.ALERT_DISPATCH_INTERVAL_MS);
  }
}

/** Nudge the loop after emitAlert queued rows, so alerts go out in ms, not at the next tick. */
export function kickDispatcher(): void {
  if (!started || running) return;
  schedule(25);
}

export function startAlertDispatcher(): void {
  if (!env.ALERT_DISPATCH_ENABLED || started) return;
  started = true;
  console.log(`[alerts] dispatcher starting — interval ${env.ALERT_DISPATCH_INTERVAL_MS}ms`);
  schedule(1_000);
  pruneTimer = setInterval(() => {
    void withJobLock("alerts:prune", env.JOB_LOCK_TTL_MS, () => pruneAlertLog())
      .then((r) => {
        if (r.acquired && r.result > 0) console.log(`[alerts] pruned ${r.result} old alert event(s)`);
      })
      .catch((err) => console.error("[alerts] prune failed:", (err as Error).message));
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
}

export function stopAlertDispatcher(): void {
  started = false;
  if (timer) clearTimeout(timer);
  if (pruneTimer) clearInterval(pruneTimer);
  timer = null;
  pruneTimer = null;
}
