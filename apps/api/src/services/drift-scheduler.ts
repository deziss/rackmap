import { Cron } from "croner";
import pLimit from "p-limit";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { withJobLock } from "./job-lock.service.js";
import { getLicenseStatus } from "./license.service.js";
import { driftErrorToHttp, takeSnapshot } from "./drift.service.js";

/**
 * Nightly configuration-drift scan on DRIFT_SCAN_CRON (default 03:30).
 *
 * Every replica fires at the same wall-clock minute, so the fleet scan takes
 * the "drift:scan" lease and keeps it until it expires (holdUntilExpiry), as the
 * SSL scan does: a replica whose clock lags must not scan the fleet again.
 * Hosts are scanned five at a time; one host failing (unreachable, locked
 * vault) is logged and never stops the others. Servers the status probe
 * currently reports down are skipped rather than waited on.
 */

const SCAN_CONCURRENCY = 5;

let job: Cron | null = null;

export interface DriftFleetScanResult {
  scanned: number;
  failed: number;
  skipped: number;
  events: number;
}

export async function scanFleetForDrift(): Promise<DriftFleetScanResult> {
  const out: DriftFleetScanResult = { scanned: 0, failed: 0, skipped: 0, events: 0 };
  const status = await getLicenseStatus();
  if (!status.features.drift_detection) {
    console.log("[drift] scheduled scan skipped: drift detection is not included in the current license");
    return out;
  }
  const servers = await prisma.server.findMany({
    where: { deletedAt: null },
    select: { id: true, hostname: true, lastStatus: true },
    orderBy: { id: "asc" },
  });
  const limit = pLimit(SCAN_CONCURRENCY);
  await Promise.all(
    servers.map((s) =>
      limit(async () => {
        if (s.lastStatus === "down") {
          out.skipped++;
          return;
        }
        try {
          const r = await takeSnapshot(s.id);
          out.scanned++;
          out.events += r.events.length;
        } catch (err) {
          out.failed++;
          console.warn(`[drift] ${s.hostname} (#${s.id}): ${driftErrorToHttp(err).message}`);
        }
      }),
    ),
  );
  console.log(
    `[drift] scan finished: ${out.scanned} scanned, ${out.failed} failed, ${out.skipped} skipped (down), ${out.events} new drift event(s)`,
  );
  return out;
}

export async function runDriftScan(): Promise<boolean> {
  const res = await withJobLock("drift:scan", env.JOB_LOCK_TTL_MS, () => scanFleetForDrift(), { holdUntilExpiry: true });
  return res.acquired;
}

export function startDriftScheduler(): void {
  if (!env.SCHEDULER_ENABLED || job) return;
  try {
    job = new Cron(env.DRIFT_SCAN_CRON, { mode: "5-part", domAndDow: false, protect: true, catch: true }, () => {
      void runDriftScan().catch((err) => console.error("[drift] scheduled scan failed:", (err as Error).message));
    });
    console.log(`[drift] scan scheduled (${env.DRIFT_SCAN_CRON}); next ${job.nextRun()?.toISOString() ?? "never"}`);
  } catch (err) {
    console.error(`[drift] DRIFT_SCAN_CRON "${env.DRIFT_SCAN_CRON}" is not a valid 5-field cron expression:`, (err as Error).message);
  }
}

export function stopDriftScheduler(): void {
  job?.stop();
  job = null;
}
