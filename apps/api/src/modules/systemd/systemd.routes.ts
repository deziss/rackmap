import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { SystemdActionInput, SystemdListQuery, SystemdLogsQuery, SystemdUnitName } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { can } from "../../lib/permissions.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import {
  assertSystemdActionAllowed,
  getSystemdUnit,
  getSystemdUnitLogs,
  listSystemdUnits,
  runSystemdAction,
  systemdErrorToHttp,
} from "../../services/systemd.service.js";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const unitParamSchema = idParamSchema.extend({ unit: SystemdUnitName });

function canSudo(c: Context): boolean {
  return can(c.get("user")?.role ?? "viewer", "server", "sudo");
}

function hostFailure(c: Context, err: unknown) {
  if (err instanceof AppError) throw err;
  const { status, code, message } = systemdErrorToHttp(err);
  return c.json({ error: { code, message } }, status);
}

/**
 * Mounted at /api/v1/servers  (/:id/systemd…). Every route needs server:systemd;
 * stop/restart/disable of a protected unit (ssh, networking, dbus, docker,
 * systemd-*, …) and any action on a .target or power-state unit additionally
 * need server:sudo. Reads are ungated by license (like GET /cron); actions need
 * the service_manager feature.
 */
export const systemdRoutes = new Hono()
  // GET /servers/:id/systemd/units?type=service|timer|socket|all&q=
  .get(
    "/:id/systemd/units",
    requireSession,
    requirePermission({ server: ["systemd"] }),
    zValidator("param", idParamSchema),
    zValidator("query", SystemdListQuery),
    async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        return c.json(await listSystemdUnits(id, query, { overridePassword: sshPass }));
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  )

  // GET /servers/:id/systemd/units/:unit — properties and the last 20 journal lines
  .get(
    "/:id/systemd/units/:unit",
    requireSession,
    requirePermission({ server: ["systemd"] }),
    zValidator("param", unitParamSchema),
    async (c) => {
      const { id, unit } = c.req.valid("param");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        return c.json(await getSystemdUnit(id, unit, { overridePassword: sshPass }));
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  )

  // GET /servers/:id/systemd/units/:unit/logs?lines=200&since=1h
  .get(
    "/:id/systemd/units/:unit/logs",
    requireSession,
    requirePermission({ server: ["systemd"] }),
    zValidator("param", unitParamSchema),
    zValidator("query", SystemdLogsQuery),
    async (c) => {
      const { id, unit } = c.req.valid("param");
      const query = c.req.valid("query");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        return c.json(await getSystemdUnitLogs(id, unit, query, { overridePassword: sshPass }));
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  )

  // POST /servers/:id/systemd/units/:unit/action {action}
  .post(
    "/:id/systemd/units/:unit/action",
    requireSession,
    requirePermission({ server: ["systemd"] }),
    zValidator("param", unitParamSchema),
    zValidator("json", SystemdActionInput),
    async (c) => {
      const { id, unit } = c.req.valid("param");
      const { action } = c.req.valid("json");
      // Static half of the protected-unit rule, before license and SSH so the answer is deterministic.
      assertSystemdActionAllowed(unit, action, canSudo(c));
      await assertFeatureEnabled("service_manager");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        return c.json(await runSystemdAction(id, unit, action, getAuditCtx(c), { overridePassword: sshPass, canSudo: canSudo(c) }));
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  );
