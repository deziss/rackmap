import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { HeartbeatMonitorInput, HeartbeatUnmonitorInput } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import { cronErrorToHttp } from "../../services/cron.service.js";
import {
  CronWriteUnconfirmedError,
  monitorCronEntry,
  unmonitorCronEntry,
  type CronMonitorCtx,
} from "../../services/heartbeat-cron.service.js";

/**
 * "Monitor this job" for the cron editor — mounted at /api/v1/servers.
 *
 *   POST /:id/cron/monitor    wrap a crontab entry so it pings a new heartbeat
 *   POST /:id/cron/unmonitor  restore the original command
 *
 * Guards: server:cron plus heartbeat:create (monitor) / heartbeat:update
 * (unmonitor). The service additionally demands server:sudo for root, /etc/crontab,
 * cron.d and root-equivalent users, re-checked against the host on every call.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

function monitorCtx(c: Context): CronMonitorCtx {
  return {
    role: c.get("user").role,
    audit: getAuditCtx(c),
    overridePassword: c.req.header("x-ssh-password") || undefined,
  };
}

/** AppErrors (403, 409 CRON_CONFLICT, …) keep their status; host failures map like the cron editor's. */
function hostError(c: Context, err: unknown) {
  if (err instanceof AppError) throw err;
  if (err instanceof CronWriteUnconfirmedError) {
    return c.json({ error: { code: "CRON_WRITE_UNCONFIRMED", message: err.message, details: { heartbeatId: err.heartbeatId } } }, 502);
  }
  const { status, code, message } = cronErrorToHttp(err);
  return c.json({ error: { code, message } }, status);
}

export const cronMonitorRoutes = new Hono()
  .use("/:id/cron/*", requireSession)

  .post(
    "/:id/cron/monitor",
    requirePermission({ server: ["cron"], heartbeat: ["create"] }),
    zValidator("param", idParam),
    zValidator("json", HeartbeatMonitorInput),
    async (c) => {
      await assertFeatureEnabled("remote_cron");
      const { id } = c.req.valid("param");
      try {
        return c.json(await monitorCronEntry(id, c.req.valid("json"), monitorCtx(c)), 201);
      } catch (err) {
        return hostError(c, err);
      }
    },
  )

  .post(
    "/:id/cron/unmonitor",
    requirePermission({ server: ["cron"], heartbeat: ["update"] }),
    zValidator("param", idParam),
    zValidator("json", HeartbeatUnmonitorInput),
    async (c) => {
      await assertFeatureEnabled("remote_cron");
      const { id } = c.req.valid("param");
      try {
        return c.json(await unmonitorCronEntry(id, c.req.valid("json"), monitorCtx(c)));
      } catch (err) {
        return hostError(c, err);
      }
    },
  );
