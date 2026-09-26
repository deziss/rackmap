import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { INSTANCE_ID, withJobLock } from "./job-lock.service.js";
import { revokeGrant } from "./access-grant.service.js";

/**
 * Revokes expired access grants.
 *
 * Every ACCESS_EXPIRY_SWEEP_INTERVAL_MS, under the "access:expiry" lease (one
 * replica at a time), active grants whose expiresAt has passed are revoked.
 * revokeGrant() claims each row with a conditional UPDATE, so even a lost lease
 * or an operator pressing "Revoke" at the same moment cannot revoke twice.
 *
 * Deliberately NOT license-gated: access granted under a Pro license must still
 * be taken away after a downgrade.
 *
 * A failed revocation goes back to `active` with attempts+1 and is retried with
 * backoff (1, 2, 4, 8 min …); the fifth failure marks it `failed` and raises a
 * critical access_revoke_failed alert (see access-grant.service.ts).
 */

/** Grants revoked per tick; the rest wait for the next tick. */
const BATCH_SIZE = 50;
/** Hosts revoked in parallel within a tick. */
const CONCURRENCY = 4;
/** A claim older than this was left by a crashed process and is released. */
const STALE_CLAIM_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/** Delay before retry number `attempts + 1`: none for the first try, then 1, 2, 4, 8, 15 min. */
export function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(2 ** (attempts - 1) * 60_000, MAX_BACKOFF_MS);
}

/**
 * retryDelayMs as a WHERE clause (`updatedAt + retryDelayMs(attempts) <= now`),
 * one branch per attempts value until the delay reaches its cap. Filtering in
 * the query — not after `take` — keeps grants waiting out their backoff from
 * filling the batch and starving grants that have only just expired.
 */
export function retryDueWhere(now: Date): Prisma.AccessGrantWhereInput {
  const before = (attempts: number) => ({ lte: new Date(now.getTime() - retryDelayMs(attempts)) });
  const branches: Prisma.AccessGrantWhereInput[] = [{ attempts: { lte: 0 } }];
  let n = 1;
  for (; retryDelayMs(n) < MAX_BACKOFF_MS; n++) branches.push({ attempts: n, updatedAt: before(n) });
  branches.push({ attempts: { gte: n }, updatedAt: before(n) });
  return { OR: branches };
}

export interface AccessSweepResult {
  due: number;
  revoked: number;
  failed: number;
  skipped: number;
  released: number;
}

export async function runAccessGrantSweep(now: Date = new Date()): Promise<AccessSweepResult> {
  // Crash recovery: a claim nobody finished (process killed mid-revoke) goes back to active.
  const released = await prisma.accessGrant.updateMany({
    where: { status: "expired_pending", updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    data: { status: "active" },
  });

  // Each row is still claimed one by one in revokeGrant(); this only picks the batch.
  const due = await prisma.accessGrant.findMany({
    where: { status: "active", expiresAt: { lte: now }, ...retryDueWhere(now) },
    select: { id: true },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE,
  });

  const result: AccessSweepResult = { due: due.length, revoked: 0, failed: 0, skipped: 0, released: released.count };
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const chunk = due.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map((g) =>
        revokeGrant(g.id, { actor: null }).catch((err) => {
          console.error(`[access-grants] revoke of grant ${g.id} threw:`, err);
          return { outcome: "failed" as const };
        }),
      ),
    );
    for (const o of outcomes) {
      if (o.outcome === "revoked") result.revoked++;
      else if (o.outcome === "failed") result.failed++;
      else result.skipped++;
    }
  }
  return result;
}

export async function runAccessGrantSweepLocked(now: Date = new Date(), holder: string = INSTANCE_ID) {
  return withJobLock("access:expiry", env.JOB_LOCK_TTL_MS, () => runAccessGrantSweep(now), { holder });
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function tick() {
  if (running) return; // overlap guard for this process; the lease guards across replicas
  running = true;
  try {
    const r = await withJobLock("access:expiry", env.JOB_LOCK_TTL_MS, () => runAccessGrantSweep());
    if (r.acquired && (r.result.revoked || r.result.failed)) {
      console.log(`[access-grants] sweep: ${r.result.revoked} revoked, ${r.result.failed} failed`);
    }
  } catch (err) {
    console.error("[access-grants] sweep failed:", err);
  } finally {
    running = false;
    if (timer !== null) timer = setTimeout(tick, env.ACCESS_EXPIRY_SWEEP_INTERVAL_MS);
  }
}

export function startAccessGrantSweeper(): void {
  if (!env.SCHEDULER_ENABLED || timer !== null) return;
  console.log(`[access-grants] expiry sweeper starting — interval ${env.ACCESS_EXPIRY_SWEEP_INTERVAL_MS}ms`);
  timer = setTimeout(tick, env.ACCESS_EXPIRY_SWEEP_INTERVAL_MS);
}

export function stopAccessGrantSweeper(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
