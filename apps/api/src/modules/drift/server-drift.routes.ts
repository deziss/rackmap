import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { DriftBaselineResponse, DriftScanResponse } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { can } from "../../lib/permissions.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import { acceptBaseline, driftErrorToHttp, getServerDrift, takeSnapshot } from "../../services/drift.service.js";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function hostFailure(c: Context, err: unknown) {
  if (err instanceof AppError) throw err;
  const { status, code, message } = driftErrorToHttp(err);
  return c.json({ error: { code, message } }, status);
}

/** Mounted at /api/v1/servers  (/:id/drift…). */
export const serverDriftRoutes = new Hono()
  // GET /servers/:id/drift — baseline, latest snapshot and open events
  .get(
    "/:id/drift",
    requireSession,
    requirePermission({ drift: ["read"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await getServerDrift(id));
    },
  )

  // POST /servers/:id/drift/scan — snapshot the host now and compare with its baseline
  .post(
    "/:id/drift/scan",
    requireSession,
    requirePermission({ drift: ["acknowledge"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      await assertFeatureEnabled("drift_detection");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const r = await takeSnapshot(id, { overridePassword: sshPass });
        const body: DriftScanResponse = {
          snapshot: r.snapshot,
          baselineCreated: r.baselineCreated,
          events: r.events,
          driftedCategories: r.driftedCategories,
        };
        return c.json(body);
      } catch (err) {
        return hostFailure(c, err);
      }
    },
  )

  // POST /servers/:id/drift/baseline — accept the latest snapshot as normal (admin decision)
  .post(
    "/:id/drift/baseline",
    requireSession,
    requirePermission({ drift: ["acknowledge"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      // Accepting a new root key or sudoers rule as normal is a root-level decision.
      if (!can(c.get("user").role, "server", "sudo")) {
        return c.json(
          { error: { code: "FORBIDDEN", message: "Accepting a drift baseline requires the server:sudo permission" } },
          403,
        );
      }
      const { id } = c.req.valid("param");
      await assertFeatureEnabled("drift_detection");
      const body: DriftBaselineResponse = await acceptBaseline(id, getAuditCtx(c));
      return c.json(body);
    },
  );
