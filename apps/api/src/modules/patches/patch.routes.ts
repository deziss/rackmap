import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PatchFleetScanInput, PatchListQuery } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import {
  getPatchSummary,
  listPatchFleet,
  queuePatchScans,
  resolvePatchScanTargets,
} from "../../services/patch.service.js";

/** Mounted at /api/v1/patches  (fleet report). */
export const patchRoutes = new Hono()
  // GET /patches — every non-deleted server with its last scan (null = never scanned)
  .get(
    "/",
    requireSession,
    requirePermission({ server: ["read"] }),
    zValidator("query", PatchListQuery),
    async (c) => c.json(await listPatchFleet(c.req.valid("query"))),
  )

  // GET /patches/summary — fleet-wide counts for the tiles
  .get("/summary", requireSession, requirePermission({ server: ["read"] }), async (c) => c.json(await getPatchSummary()))

  // POST /patches/scan — queue background scans (all servers, or `serverIds`)
  .post(
    "/scan",
    requireSession,
    requirePermission({ server: ["patch"] }),
    zValidator("json", PatchFleetScanInput),
    async (c) => {
      const input = c.req.valid("json");
      await assertFeatureEnabled("patch_management");
      const ids = await resolvePatchScanTargets(input.serverIds);
      const queued = queuePatchScans(ids, { refresh: true });
      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "data",
        action: "server.patch_scan",
        entity: "server",
        after: { scope: input.serverIds ? "selected" : "fleet", servers: ids.length, queued },
      });
      return c.json({ queued }, 202);
    },
  );
