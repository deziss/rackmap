import { Hono } from "hono";
import { prisma } from "../../db.js";
import { getBackupHealth } from "../../services/backup.service.js";

/**
 * Backup state for the readiness probe. Informational only: a broken backup
 * must be visible to monitoring, but it is no reason to pull the instance out
 * of rotation, so it never changes the status code.
 *
 * This endpoint is unauthenticated, so it carries a coarse reason code and a
 * timestamp only — never pg_dump's error text, which can name hosts and paths.
 */
function backupSummary() {
  const b = getBackupHealth();
  if (!b.enabled) return { status: "disabled" as const };
  const reason = b.scheduleError
    ? "invalid_schedule"
    : b.pgDump === "missing"
      ? "pg_dump_missing"
      : b.lastError
        ? "last_run_failed"
        : undefined;
  return {
    status: reason ? ("degraded" as const) : ("ok" as const),
    ...(reason ? { reason } : {}),
    lastSuccessAt: b.lastSuccessAt,
  };
}

export const healthRoutes = new Hono()
  .get("/live", (c) => c.json({ status: "ok" }))
  .get("/ready", async (c) => {
    const backup = backupSummary();
    try {
      await prisma.$queryRaw`SELECT 1`;
      return c.json({ status: "ok", db: "ok", backup });
    } catch {
      return c.json({ status: "degraded", db: "unreachable", backup }, 503);
    }
  });
