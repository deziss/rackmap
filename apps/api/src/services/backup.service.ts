import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "../env.js";

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

/** Schedule nightly backup via setTimeout loop. Only runs if BACKUP_DIR is set. */
export function scheduleBackup(): void {
  if (!env.BACKUP_DIR) return;

  function tick() {
    runBackup();
    // Next run: 24h
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }

  // First run: time until next midnight
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  const msUntilMidnight = midnight.getTime() - now.getTime();

  setTimeout(tick, msUntilMidnight);
  console.log(`[backup] scheduled — first run in ${Math.round(msUntilMidnight / 60_000)}m`);
}
