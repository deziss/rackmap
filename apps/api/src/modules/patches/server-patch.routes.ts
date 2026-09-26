import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { PatchApplyInput, PatchScanInput } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { can } from "../../lib/permissions.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import {
  applyServerPatches,
  getServerPatchStatus,
  patchErrorToHttp,
  scanServerPatches,
} from "../../services/patch.service.js";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function hostFailure(c: Context, err: unknown) {
  if (err instanceof AppError) throw err;
  const { status, code, message } = patchErrorToHttp(err);
  return c.json({ error: { code, message } }, status);
}

/** Mounted at /api/v1/servers  (/:id/patches…). */
export const serverPatchRoutes = new Hono()
  // GET /servers/:id/patches — the last scan result, or null when never scanned
  .get(
    "/:id/patches",
    requireSession,
    requirePermission({ server: ["read"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await getServerPatchStatus(id));
    },
  )

  // POST /servers/:id/patches/scan — scan now (refreshes the package index by default)
  .post(
    "/:id/patches/scan",
    requireSession,
    requirePermission({ server: ["patch"] }),
    zValidator("param", idParamSchema),
    zValidator("json", PatchScanInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      await assertFeatureEnabled("patch_management");
      const refresh = input.refresh ?? true;
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const status = await scanServerPatches(id, { refresh, overridePassword: sshPass });
        await writeAuditDirect({
          ctx: getAuditCtx(c),
          category: "data",
          action: "server.patch_scan",
          entity: "server",
          entityId: String(id),
          after: {
            refresh,
            status: status.status,
            upgradableCount: status.upgradableCount,
            securityCount: status.securityCount,
            rebootRequired: status.rebootRequired,
          },
        });
        return c.json(status);
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  )

  // POST /servers/:id/patches/apply — install updates as root (never reboots); needs server:sudo too
  .post(
    "/:id/patches/apply",
    requireSession,
    requirePermission({ server: ["patch"] }),
    zValidator("param", idParamSchema),
    zValidator("json", PatchApplyInput),
    async (c) => {
      if (!can(c.get("user")?.role ?? "viewer", "server", "sudo")) {
        return c.json(
          { error: { code: "FORBIDDEN", message: "Applying updates runs as root and requires the server:sudo permission" } },
          403,
        );
      }
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      await assertFeatureEnabled("patch_management");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        return c.json(await applyServerPatches(id, input, getAuditCtx(c), { overridePassword: sshPass }));
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  );
