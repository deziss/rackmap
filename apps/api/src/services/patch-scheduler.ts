import { Cron } from "croner";
import { env } from "../env.js";
import { withJobLock } from "./job-lock.service.js";
import { resolvePatchScanTargets, scanPatchesBatch } from "./patch.service.js";

/**
 * Fleet patch scan on PATCH_SCAN_CRON (default 03:00 daily): every non-deleted
 * server, package index refreshed, PATCH_SCAN_CONCURRENCY hosts at a time. A
 * host that fails is recorded on its own row (status "error") and never stops
 * the sweep.
 *
 * Every replica fires at the same wall-clock minute, so the sweep takes the
 * "patch:scan" lease and keeps it until it expires (holdUntilExpiry), exactly
 * like the SSL daily scan: a replica whose clock is a little behind must not
 * pick up a freed lease and scan the whole fleet a second time.
 */

let job: Cron | null = null;

export async function runPatchSweep(): Promise<{ total: number; ok: number; failed: number }> {
  const ids = await resolvePatchScanTargets();
  const { ok, failed } = await scanPatchesBatch(ids, { refresh: true });
  return { total: ids.length, ok, failed };
}

export async function runScheduledPatchScan(): Promise<boolean> {
  const res = await withJobLock("patch:scan", env.JOB_LOCK_TTL_MS, () => runPatchSweep(), { holdUntilExpiry: true });
  if (res.acquired) {
    const { total, ok, failed } = res.result;
    console.log(`[patches] scheduled scan: ${total} server(s), ${ok} scanned, ${failed} failed`);
  }
  return res.acquired;
}

export function startPatchScheduler(): void {
  if (!env.SCHEDULER_ENABLED || job) return;
  try {
    job = new Cron(env.PATCH_SCAN_CRON, { mode: "5-part", domAndDow: false, protect: true, catch: true }, () => {
      void runScheduledPatchScan().catch((err) => console.error("[patches] scheduled scan failed:", (err as Error).message));
    });
    console.log(`[patches] fleet scan scheduled (${env.PATCH_SCAN_CRON}); next ${job.nextRun()?.toISOString() ?? "never"}`);
  } catch (err) {
    console.error(`[patches] PATCH_SCAN_CRON "${env.PATCH_SCAN_CRON}" is not a valid 5-field cron expression:`, (err as Error).message);
  }
}

export function stopPatchScheduler(): void {
  job?.stop();
  job = null;
}
