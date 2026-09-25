import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RunbookOutputQuery, RunbookRejectInput, RunbookRerunInput, RunbookRunListQuery } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { callerOf, runRequestLimit } from "./runbook.context.js";
import {
  approveRun,
  cancelRun,
  getHostOutput,
  getRunDetail,
  listRuns,
  pendingApprovalCount,
  rejectRun,
  rerunRun,
} from "./runbook.service.js";

/**
 * /api/v1/runbook-runs — run history, live output (polled), and the approval
 * workflow. Approving needs runbook:approve (admin) and a different person from
 * the requester; that check lives in approveRun so it also binds admins.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });
const outputParam = z.object({
  id: z.coerce.number().int().positive(),
  serverId: z.coerce.number().int().positive(),
});

export const runbookRunRoutes = new Hono()
  .use(requireSession)

  // GET /runbook-runs?runbookId&status&cursor
  .get("/", requirePermission({ runbook: ["read"] }), zValidator("query", RunbookRunListQuery), async (c) => {
    return c.json(await listRuns(c.req.valid("query")));
  })

  // GET /runbook-runs/pending-count — sidebar approvals badge
  .get("/pending-count", requirePermission({ runbook: ["approve"] }), async (c) => {
    return c.json({ count: await pendingApprovalCount() });
  })

  // GET /runbook-runs/:id — run plus host rows, without output
  .get("/:id", requirePermission({ runbook: ["read"] }), zValidator("param", idParam), async (c) => {
    return c.json(await getRunDetail(c.req.valid("param").id));
  })

  // GET /runbook-runs/:id/hosts/:serverId/output?stdoutFrom&stderrFrom — incremental output
  .get(
    "/:id/hosts/:serverId/output",
    requirePermission({ runbook: ["read"] }),
    zValidator("param", outputParam),
    zValidator("query", RunbookOutputQuery),
    async (c) => {
      const { id, serverId } = c.req.valid("param");
      return c.json(await getHostOutput(id, serverId, c.req.valid("query")));
    },
  )

  // POST /runbook-runs/:id/approve
  .post("/:id/approve", requirePermission({ runbook: ["approve"] }), zValidator("param", idParam), async (c) => {
    return c.json(await approveRun(c.req.valid("param").id, callerOf(c)));
  })

  // POST /runbook-runs/:id/reject
  .post(
    "/:id/reject",
    requirePermission({ runbook: ["approve"] }),
    zValidator("param", idParam),
    zValidator("json", RunbookRejectInput),
    async (c) => {
      return c.json(await rejectRun(c.req.valid("param").id, c.req.valid("json").reason, callerOf(c)));
    },
  )

  // POST /runbook-runs/:id/cancel — requester or admin
  .post("/:id/cancel", requirePermission({ runbook: ["execute"] }), zValidator("param", idParam), async (c) => {
    return c.json(await cancelRun(c.req.valid("param").id, callerOf(c)));
  })

  // POST /runbook-runs/:id/rerun {onlyFailed}
  .post(
    "/:id/rerun",
    requirePermission({ runbook: ["execute"] }),
    runRequestLimit,
    zValidator("param", idParam),
    zValidator("json", RunbookRerunInput),
    async (c) => {
      return c.json(await rerunRun(c.req.valid("param").id, c.req.valid("json").onlyFailed, callerOf(c)), 201);
    },
  );
