import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma } from "../db.js";

/**
 * Database-backed leases for the background loops.
 *
 * Every background job in this API is guarded in-process by a module-level
 * `running` boolean. That is enough for one process and nothing more: run two
 * API replicas (`docker compose up --scale api=2`, or PM2 with `instances > 1`)
 * and every server is probed twice, every alert fires twice, and two nightly
 * backups copy the same SQLite file at the same moment.
 *
 * The database is the only thing all replicas share, so it holds the lease. A
 * replica may run a job only while it owns the job's row: `holder` equal to its
 * own instance id and `expiresAt` still in the future. The lease is renewed
 * while the job runs and released when it finishes; if the holder dies, nothing
 * renews it and the next replica to come along takes it once it expires.
 */

/**
 * Identity of THIS process, generated once at module load. Host and pid make it
 * readable in the table when an operator asks "who is the leader right now?";
 * the random suffix keeps it unique across a container that reuses pid 1 and
 * across two replicas on the same host.
 */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * Renew at a third of the TTL, so a lease survives two consecutive failed
 * renewals (a slow query, a brief connection blip) before another replica can
 * legitimately take it. Never faster than once a second, however small the TTL.
 */
function heartbeatIntervalMs(ttlMs: number): number {
  return Math.max(1_000, Math.floor(ttlMs / 3));
}

/** Prisma's unique-constraint violation, i.e. another replica inserted the row first. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Take the lease for `name`, or report that someone else holds it.
 *
 * Race-freedom rests on the whole check-and-take being ONE conditional statement
 * rather than a read followed by a write:
 *
 *   1. `UPDATE scheduler_lock SET holder = ?, expires_at = ? WHERE name = ? AND expires_at <= now`
 *      The expiry test lives in the WHERE clause, so the database evaluates it
 *      while holding the row's write lock. Two replicas racing for the same
 *      expired lease serialize on that lock: the first moves `expires_at` into
 *      the future, and the second's predicate then matches zero rows. Prisma
 *      reports that as `count`, which is the acquisition verdict.
 *   2. Only if no row exists yet (`count === 0` and nothing to update) do we
 *      INSERT. That race is decided by the unique index on `name`: exactly one
 *      INSERT can succeed, and the loser gets P2002 and skips.
 *
 * There is deliberately no `findUnique` anywhere in this path — a read-then-write
 * is precisely the interleaving the lease exists to prevent.
 */
export async function acquireJobLock(name: string, ttlMs: number, holder: string = INSTANCE_ID): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const { count } = await prisma.schedulerLock.updateMany({
    where: { name, expiresAt: { lte: now } },
    data: { holder, acquiredAt: now, heartbeatAt: now, expiresAt },
  });
  if (count > 0) return true;

  // Nothing was updated: either the lease is live (someone else's) or this job has
  // never run anywhere and has no row yet. Only the second case is worth an INSERT.
  //
  // This read is NOT the acquisition decision — that stays with the UPDATE above and
  // the unique index below, both of which are atomic. It only avoids firing an INSERT
  // that is certain to fail: the row exists for the lifetime of the deployment, so
  // without this check every non-leader replica would throw (and have Prisma log) a
  // unique violation on every single tick. If the lease happens to expire between
  // this read and the next tick, the next tick takes it; nothing is lost but a tick.
  const existing = await prisma.schedulerLock.findUnique({ where: { name }, select: { id: true } });
  if (existing) return false;

  try {
    await prisma.schedulerLock.create({
      data: { name, holder, acquiredAt: now, heartbeatAt: now, expiresAt },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Push the lease deadline out by another `ttlMs`. Returns false if we no longer
 * hold it — either it expired and another replica took over, or this was never
 * our lease. Conditional on both `holder` and a still-live `expiresAt`, so a
 * late heartbeat from a stalled process can never resurrect a lease that has
 * already been handed to someone else.
 */
export async function renewJobLock(name: string, ttlMs: number, holder: string = INSTANCE_ID): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.schedulerLock.updateMany({
    where: { name, holder, expiresAt: { gt: now } },
    data: { heartbeatAt: now, expiresAt: new Date(now.getTime() + ttlMs) },
  });
  return count > 0;
}

/**
 * Give the lease up early by expiring it in place. The row is kept rather than
 * deleted: it is a useful record of which instance last ran the job and when,
 * and rewriting one row is cheaper than churning inserts.
 *
 * Conditional on `holder`, so a process whose lease already expired and was taken
 * by another replica cannot release a lease it no longer owns.
 */
export async function releaseJobLock(name: string, holder: string = INSTANCE_ID): Promise<void> {
  const now = new Date();
  await prisma.schedulerLock.updateMany({
    where: { name, holder },
    data: { heartbeatAt: now, expiresAt: now },
  });
}

export type JobLockResult<T> = { acquired: true; result: T } | { acquired: false; result?: undefined };

export interface JobLockOptions {
  /** Override the lease holder. Tests use it to stand in for a second replica. */
  holder?: string;
  /**
   * Keep the lease until it expires instead of releasing it when `fn` returns.
   * For a job that runs once per wall-clock moment on every replica (the nightly
   * backup), releasing immediately would let a replica whose clock is a second
   * behind pick up the freed lease and do the same work again.
   */
  holdUntilExpiry?: boolean;
}

/**
 * Run `fn` only if this process can take the `name` lease; otherwise do nothing.
 *
 * Not winning the lease is the normal state for every replica but one, so it is
 * not logged and not an error — at a 60s tick, logging it would produce 1,440
 * lines a day per replica saying "still not the leader".
 *
 * While `fn` runs, a timer renews the lease every TTL/3. This matters: the
 * metrics sweep can take 30-45s against a large fleet and the ping sweep is
 * unbounded, so a lease sized to the job's *expected* duration would expire
 * mid-run on a bad day and let a second replica start the same sweep.
 *
 * The lease is released in a `finally`, so a throwing job frees it immediately
 * rather than blocking the next tick for the rest of the TTL. A process that is
 * killed outright never reaches that `finally` — which is what the TTL is for:
 * the heartbeat stops with the process, and the lease becomes takeable by any
 * replica at most `ttlMs` after the last renewal, with no operator cleanup.
 */
export async function withJobLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts: JobLockOptions = {},
): Promise<JobLockResult<T>> {
  const holder = opts.holder ?? INSTANCE_ID;

  const acquired = await acquireJobLock(name, ttlMs, holder);
  if (!acquired) return { acquired: false };

  let lostLease = false;
  const heartbeat = setInterval(() => {
    void renewJobLock(name, ttlMs, holder)
      .then((renewed) => {
        // Worth a line: it means the job ran longer than the lease survived and
        // another replica may now be running it too.
        if (!renewed && !lostLease) {
          lostLease = true;
          console.warn(`[job-lock] ${name}: lease lost while the job was still running`);
        }
      })
      .catch((err) => {
        console.warn(`[job-lock] ${name}: renew failed:`, err);
      });
  }, heartbeatIntervalMs(ttlMs));
  // Never let the heartbeat hold the event loop open on shutdown.
  heartbeat.unref?.();

  try {
    return { acquired: true, result: await fn() };
  } finally {
    clearInterval(heartbeat);
    if (!opts.holdUntilExpiry) {
      try {
        await releaseJobLock(name, holder);
      } catch (err) {
        // Must not mask the job's own error. The lease expires on its own anyway.
        console.error(`[job-lock] ${name}: release failed, lease will expire on its own:`, err);
      }
    }
  }
}
