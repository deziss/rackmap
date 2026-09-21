import { env } from "../env.js";
import { runAll, pruneStatusHistory } from "./status.service.js";
import { runAllServices } from "./service-status.service.js";
import { withJobLock } from "./job-lock.service.js";

/**
 * One lease for the whole tick, not one per sub-job.
 *
 * The three sub-jobs run sequentially inside a single loop, so splitting the
 * lease three ways could not let a second replica run any of them in parallel —
 * the winner of `prune` would still be waiting on its own `servers` sweep. What
 * it would add is three lock round-trips a minute instead of one, and the chance
 * of leadership flipping mid-tick, so one replica prunes the status history that
 * another is still writing.
 *
 * The metrics sweep and the nightly backup do hold their own leases: they run on
 * their own timers and are independent workloads, so letting them land on
 * different replicas actually spreads the SSH and I/O load.
 */
const LOCK_NAME = "scheduler:tick";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tick() {
  if (running) return; // overlap guard — this process only; the lease guards across processes
  running = true;
  try {
    // A replica that does not win the lease does nothing this tick, quietly.
    await withJobLock(LOCK_NAME, env.JOB_LOCK_TTL_MS, async () => {
      // Each sub-job is isolated: a single try/catch around all three meant a throw
      // in runAll() also skipped the service sweep and the history prune for that
      // tick, so one failing subsystem quietly stopped two others.
      for (const [name, job] of [
        ["servers", runAll],
        ["services", runAllServices],
        ["prune", pruneStatusHistory],
      ] as const) {
        try {
          await job();
        } catch (err) {
          console.error(`[scheduler] ${name} failed:`, err);
        }
      }
    });
  } catch (err) {
    // Only reachable if the lease itself failed (database unreachable, say) — the
    // sub-jobs above swallow their own errors. Log it and let the next tick retry.
    console.error("[scheduler] lock error:", err);
  } finally {
    // In a finally so a throw here can never strand `running` at true and leave the
    // scheduler permanently stopped with no timer queued.
    running = false;
    if (timer !== null) {
      // reschedule only if not stopped
      timer = setTimeout(tick, env.PING_INTERVAL_MS);
    }
  }
}

export function startScheduler() {
  if (!env.SCHEDULER_ENABLED) return;
  console.log(`[scheduler] starting — interval ${env.PING_INTERVAL_MS}ms, concurrency ${env.PING_CONCURRENCY}`);
  timer = setTimeout(tick, env.PING_INTERVAL_MS);
}

export function stopScheduler() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
