import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { StatusHistoryPruneInput } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx, writeAudit } from "../../lib/audit.js";
import { getStatusHistoryStats, purgeStatusHistory } from "../../services/status.service.js";

/** Probe-history storage maintenance (admin). Mounted at /api/v1/status-history. */
export const statusHistoryRoutes = new Hono()
  .use(requireSession)

  // GET /status-history/stats — row count, age range and the storage settings
  .get("/stats", requirePermission({ maintenance: ["manage"] }), async (c) => {
    return c.json(await getStatusHistoryStats());
  })

  // POST /status-history/prune — delete by age and/or keep only the newest N
  .post(
    "/prune",
    requirePermission({ maintenance: ["manage"] }),
    zValidator("json", StatusHistoryPruneInput),
    async (c) => {
      const input = c.req.valid("json");
      const deleted = await purgeStatusHistory(input);
      await writeAudit({
        ctx: getAuditCtx(c),
        category: "data",
        action: "status_history.prune",
        entity: "StatusCheck",
        after: { ...input, deleted },
      });
      return c.json({ deleted });
    },
  );
