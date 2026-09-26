import { env } from "../env.js";
import { withJobLock } from "./job-lock.service.js";
import { reapRunbookRuns, startRunbookWorker, stopRunbookWorker } from "./runbook-executor.service.js";
import { runRunbookScheduleTick } from "./runbook-scheduler.js";

/**
 * Starts/stops everything runbooks do in the background, wired into index.ts
 * (never into createApp(), so tests drive these functions directly):
 *
 *  - the run worker (every replica with RUNBOOK_WORKER_ENABLED; runs are claimed
 *    per row, so replicas share the work without a global lock);
 *  - the reaper, every 30s under the `runbook:reaper` lease — fails runs whose
 *    executor died and expires stale approvals;
 *  - the scheduler, every 30s under the `runbook:schedule` lease, only when
 *    SCHEDULER_ENABLED.
 */

const SWEEP_MS = 30_000;

let reaperTimer: ReturnType<typeof setInterval> | null = null;
let scheduleTimer: ReturnType<typeof setInterval> | null = null;
let reaping = false;
let scheduling = false;

async function reaperTick() {
  if (reaping) return;
  reaping = true;
  try {
    await withJobLock("runbook:reaper", env.JOB_LOCK_TTL_MS, async () => {
      const { lost, expired } = await reapRunbookRuns();
      if (lost || expired) console.log(`[runbooks] reaper: ${lost} lost run(s) failed, ${expired} approval(s) expired`);
    });
  } catch (err) {
    console.error("[runbooks] reaper failed:", err);
  } finally {
    reaping = false;
  }
}

async function scheduleTick() {
  if (scheduling) return;
  scheduling = true;
  try {
    await withJobLock("runbook:schedule", env.JOB_LOCK_TTL_MS, async () => {
      await runRunbookScheduleTick();
    });
  } catch (err) {
    console.error("[runbooks] schedule tick failed:", err);
  } finally {
    scheduling = false;
  }
}

export function startRunbookBackground(): void {
  if (env.RUNBOOK_WORKER_ENABLED) {
    startRunbookWorker();
    reaperTimer ??= setInterval(() => void reaperTick(), SWEEP_MS);
    reaperTimer.unref?.();
  }
  if (env.SCHEDULER_ENABLED) {
    scheduleTimer ??= setInterval(() => void scheduleTick(), SWEEP_MS);
    scheduleTimer.unref?.();
  }
}

export async function stopRunbookBackground(opts: { markOwnFailed?: boolean } = {}): Promise<void> {
  if (reaperTimer) clearInterval(reaperTimer);
  if (scheduleTimer) clearInterval(scheduleTimer);
  reaperTimer = null;
  scheduleTimer = null;
  await stopRunbookWorker({ markOwnFailed: opts.markOwnFailed });
}
