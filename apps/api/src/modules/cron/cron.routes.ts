import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { CronRunInput, CronSaveInput, type CronTarget } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { can } from "../../lib/permissions.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import {
  cronErrorToHttp,
  cronTargetLabel,
  cronTargetNeedsSudo,
  readCronTargets,
  runCronEntry,
  writeCronTarget,
} from "../../services/cron.service.js";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function canSudo(c: Context): boolean {
  return can(c.get("user")?.role ?? "viewer", "server", "sudo");
}

/**
 * Static half of the sudo rule: system crontab, cron.d and root need server:sudo
 * whatever the host says. Checked before license and SSH so the answer is
 * deterministic; the service re-checks privileged users on the fresh host read.
 */
function staticSudoDenied(c: Context, target: CronTarget) {
  if (!cronTargetNeedsSudo(target) || canSudo(c)) return null;
  return c.json(
    { error: { code: "FORBIDDEN", message: `Editing ${cronTargetLabel(target)} requires the server:sudo permission` } },
    403,
  );
}

function hostFailure(c: Context, err: unknown) {
  if (err instanceof AppError) throw err;
  const { status, code, message } = cronErrorToHttp(err);
  return c.json({ error: { code, message } }, status);
}

/** Mounted at /api/v1/servers  (/:id/cron…). */
export const cronRoutes = new Hono()
  // GET /servers/:id/cron — every crontab on the host, /etc/cron.d, and (read-only) systemd timers
  .get(
    "/:id/cron",
    requireSession,
    requirePermission({ server: ["cron"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        return c.json(await readCronTargets(id, { overridePassword: sshPass }));
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  )

  // PUT /servers/:id/cron — replace one target (compare-and-set on baseHash)
  .put(
    "/:id/cron",
    requireSession,
    requirePermission({ server: ["cron"] }),
    zValidator("param", idParamSchema),
    zValidator("json", CronSaveInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const denied = staticSudoDenied(c, input.target);
      if (denied) return denied;
      await assertFeatureEnabled("remote_cron");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        return c.json(await writeCronTarget(id, input, getAuditCtx(c), { overridePassword: sshPass, canSudo: canSudo(c) }));
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  )

  // POST /servers/:id/cron/run — run one saved entry now, as its user (60s, 64 KiB output)
  .post(
    "/:id/cron/run",
    requireSession,
    requirePermission({ server: ["cron"] }),
    zValidator("param", idParamSchema),
    zValidator("json", CronRunInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const denied = staticSudoDenied(c, input.target);
      if (denied) return denied;
      await assertFeatureEnabled("remote_cron");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        return c.json(await runCronEntry(id, input, getAuditCtx(c), { overridePassword: sshPass, canSudo: canSudo(c) }));
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  );
