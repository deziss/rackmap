import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { AlertEventListQuery } from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { listEvents } from "../../services/alert-channel.service.js";

/** Mounted at /api/v1/alert-events: the alert outbox, newest first, with per-channel delivery status. */
export const alertEventRoutes = new Hono()
  .use(requireSession)

  // GET /alert-events?type&cursor
  .get("/", requirePermission({ alertChannel: ["manage"] }), zValidator("query", AlertEventListQuery), async (c) => {
    return c.json(await listEvents(c.req.valid("query")));
  });
