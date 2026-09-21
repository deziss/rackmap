import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "../env.js";
import { withJobLock } from "./job-lock.service.js";

const LOCK_NAME = "backup:nightly";

/**
 * The nightly backup gets its own lease, and a long, fixed one rather than
 * JOB_LOCK_TTL_MS.
 *
 * Every replica's timer fires at its own local midnight and the copy itself can
 * be over in milliseconds, so a lease released the moment the copy finishes
 * would simply be picked up by the replica whose clock is a second behind, which
 * would then back the same database up again. This lease is therefore held until
 * it expires (`holdUntilExpiry`) instead of being released: ten minutes
 * comfortably covers NTP-level skew between replicas, and since the job runs
 * once a day nothing is lost by sitting on it.
 */
const BACKUP_LOCK_TTL_MS = 10 * 60 * 1000;

/** Copy the SQLite DB file to BACKUP_DIR with a timestamped name. No-op if BACKUP_DIR not set. */
export function runBackup(): void {
  if (!env.BACKUP_DIR) return;

  // Extract file path from DATABASE_URL: "file:/data/inventory.db" → "/data/inventory.db"
  const dbPath = env.DATABASE_URL.replace(/^file:/, "");

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const destDir = env.BACKUP_DIR;

  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, `inventory-${stamp}.db`);

  try {
    cpSync(dbPath, dest);
    console.log(`[backup] ${dest}`);
  } catch (e) {
    console.error("[backup] failed:", (e as Error).message);
  }
}

/**
 * The scheduled backup: `runBackup()` behind the cross-replica lease, so exactly
 * one instance copies the database each night. `runBackup()` itself is left
 * unlocked — an operator asking for a backup on demand should get one.
 */
async function runScheduledBackup(): Promise<void> {
  try {
    await withJobLock(LOCK_NAME, BACKUP_LOCK_TTL_MS, async () => runBackup(), { holdUntilExpiry: true });
  } catch (err) {
    // Lease failure only (runBackup handles its own errors). Never let it break
    // the reschedule below, or the backup loop stops for good.
    console.error("[backup] lock error:", (err as Error).message);
  }
}

/** Schedule nightly backup via setTimeout loop. Only runs if BACKUP_DIR is set. */
export function scheduleBackup(): void {
  if (!env.BACKUP_DIR) return;

  async function tick() {
    await runScheduledBackup();
    // Next run: 24h
    setTimeout(() => void tick(), 24 * 60 * 60 * 1000);
  }

  // First run: time until next midnight
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  const msUntilMidnight = midnight.getTime() - now.getTime();

  setTimeout(() => void tick(), msUntilMidnight);
  console.log(`[backup] scheduled — first run in ${Math.round(msUntilMidnight / 60_000)}m`);
}
