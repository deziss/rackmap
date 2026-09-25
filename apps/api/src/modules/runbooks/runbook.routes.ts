import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  RunbookCreateInput,
  RunbookPreviewTargetsInput,
  RunbookRunRequestInput,
  RunbookUpdateInput,
} from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { callerOf, runRequestLimit } from "./runbook.context.js";
import {
  createRunbook,
  deleteRunbook,
  getRunbook,
  listRunbooks,
  previewRunbookTargets,
  requestRun,
  updateRunbook,
} from "./runbook.service.js";

/**
 * /api/v1/runbooks — definitions (admin-authored) and run requests.
 *
 * Authoring (create/update/delete) is admin-only: a runbook is code that runs on
 * many hosts, possibly as root. Editors hold runbook:execute and may request
 * runs; see runbook.service.ts for when a run waits for approval.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

export const runbookRoutes = new Hono()
  .use(requireSession)

  // GET /runbooks — with each one's last run status
  .get("/", requirePermission({ runbook: ["read"] }), async (c) => {
    return c.json({ items: await listRunbooks() });
  })

  // POST /runbooks
  .post("/", requirePermission({ runbook: ["create"] }), zValidator("json", RunbookCreateInput), async (c) => {
    return c.json(await createRunbook(c.req.valid("json"), callerOf(c)), 201);
  })

  // GET /runbooks/:id
  .get("/:id", requirePermission({ runbook: ["read"] }), zValidator("param", idParam), async (c) => {
    return c.json(await getRunbook(c.req.valid("param").id));
  })

  // PATCH /runbooks/:id — bumps `version` when script, parameters, interpreter or runAs change
  .patch(
    "/:id",
    requirePermission({ runbook: ["update"] }),
    zValidator("param", idParam),
    zValidator("json", RunbookUpdateInput),
    async (c) => {
      return c.json(await updateRunbook(c.req.valid("param").id, c.req.valid("json"), callerOf(c)));
    },
  )

  // DELETE /runbooks/:id — soft delete; run history is kept
  .delete("/:id", requirePermission({ runbook: ["delete"] }), zValidator("param", idParam), async (c) => {
    await deleteRunbook(c.req.valid("param").id, callerOf(c));
    return c.json({ ok: true });
  })

  // POST /runbooks/:id/preview-targets — resolved servers plus warnings, before running
  .post(
    "/:id/preview-targets",
    requirePermission({ runbook: ["execute"] }),
    zValidator("param", idParam),
    zValidator("json", RunbookPreviewTargetsInput),
    async (c) => {
      return c.json(await previewRunbookTargets(c.req.valid("param").id, c.req.valid("json"), c.get("user")));
    },
  )

  // POST /runbooks/:id/runs — request a run (queued, or pending_approval)
  .post(
    "/:id/runs",
    requirePermission({ runbook: ["execute"] }),
    runRequestLimit,
    zValidator("param", idParam),
    zValidator("json", RunbookRunRequestInput),
    async (c) => {
      return c.json(await requestRun(c.req.valid("param").id, c.req.valid("json"), callerOf(c)), 201);
    },
  );
