import { Cron } from "croner";
import { env } from "../env.js";
import { withJobLock } from "./job-lock.service.js";
import { scanAllDomains } from "../modules/health/ssl-checker.js";

/**
 * Scheduled SSL certificate scan on SSL_SCAN_CRON (default 06:00 daily).
 *
 * Before this there was no scheduled scan at all: certificates were only
 * rescanned when someone pressed "Scan" in the UI, so ssl_expiring alerts
 * would never have fired on their own. scanAllDomains() raises them at the
 * 30/14/7/1-day thresholds.
 *
 * Every replica runs the same cron at the same wall-clock minute, so the job
 * takes the "ssl:daily" lease and keeps it until it expires (holdUntilExpiry):
 * a replica whose clock is a few seconds behind must not pick up a freed lease
 * and scan the whole fleet a second time.
 */

let job: Cron | null = null;

export async function runSslDailyScan(): Promise<boolean> {
  const res = await withJobLock("ssl:daily", env.JOB_LOCK_TTL_MS, () => scanAllDomains(false), { holdUntilExpiry: true });
  return res.acquired;
}

export function startSslDailyScan(): void {
  if (!env.SCHEDULER_ENABLED || job) return;
  try {
    job = new Cron(env.SSL_SCAN_CRON, { mode: "5-part", domAndDow: false, protect: true, catch: true }, () => {
      void runSslDailyScan().catch((err) => console.error("[ssl] scheduled scan failed:", (err as Error).message));
    });
    console.log(`[ssl] daily scan scheduled (${env.SSL_SCAN_CRON}); next ${job.nextRun()?.toISOString() ?? "never"}`);
  } catch (err) {
    console.error(`[ssl] SSL_SCAN_CRON "${env.SSL_SCAN_CRON}" is not a valid 5-field cron expression:`, (err as Error).message);
  }
}

export function stopSslDailyScan(): void {
  job?.stop();
  job = null;
}
