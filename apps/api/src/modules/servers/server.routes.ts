import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import { ServerCreateInput, ServerUpdateInput, ServerListQuery } from "@inv/shared";
import {
  listServers,
  getServer,
  createServer,
  updateServer,
  softDeleteServer,
  restoreServer,
  revealServerPassword,
  getStatusHistory,
} from "./server.service.js";
import { runCheck, runAll } from "../../services/status.service.js";
import { fetchMetrics } from "../../services/metrics.service.js";
import { sshErrorToHttp } from "../../services/ssh.service.js";
import { env } from "../../env.js";
import { prisma } from "../../db.js";

// Throttle metrics-view audit: one row per user·server per 5 min (the page polls every 5s).
const METRICS_AUDIT_TTL_MS = 5 * 60 * 1000;
const metricsAuditSeen = new Map<string, number>();
function shouldAuditMetrics(userId: string, serverId: number): boolean {
  const key = `${userId}:${serverId}`;
  const now = Date.now();
  const last = metricsAuditSeen.get(key);
  if (last && now - last < METRICS_AUDIT_TTL_MS) return false;
  metricsAuditSeen.set(key, now);
  return true;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const serverRoutes = new Hono()
  .use(requireSession)

  // GET /servers — all authenticated users can list
  .get("/", zValidator("query", ServerListQuery), async (c) => {
    const user = c.get("user");
    const query = c.req.valid("query");
    const isAdmin = user.role === "admin";
    return c.json(await listServers(query, isAdmin));
  })

  // POST /servers
  .post(
    "/",
    requirePermission({ server: ["create"] }),
    zValidator("json", ServerCreateInput),
    async (c) => {
      const input = c.req.valid("json");
      const dto = await createServer(input, getAuditCtx(c));
      return c.json(dto, 201);
    },
  )

  // GET /servers/:id
  .get("/:id", zValidator("param", idParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await getServer(id));
  })

  // PATCH /servers/:id
  .patch(
    "/:id",
    requirePermission({ server: ["update"] }),
    zValidator("param", idParamSchema),
    zValidator("json", ServerUpdateInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      return c.json(await updateServer(id, input, getAuditCtx(c)));
    },
  )

  // DELETE /servers/:id — soft delete
  .delete(
    "/:id",
    requirePermission({ server: ["delete"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      await softDeleteServer(id, getAuditCtx(c));
      return c.json({ ok: true });
    },
  )

  // POST /servers/:id/restore
  .post(
    "/:id/restore",
    requirePermission({ server: ["restore"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await restoreServer(id, getAuditCtx(c)));
    },
  )

  // POST /servers/:id/reveal-password — admin/editor OR viewer with approved AccessRequest
  .post(
    "/:id/reveal-password",
    zValidator("param", idParamSchema),
    async (c) => {
      const user = c.get("user") as { id?: string; role?: string } | undefined;
      if (!user?.id) return c.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
      const { id } = c.req.valid("param");

      const hasDirectPerm = user.role === "admin" || user.role === "editor";
      if (!hasDirectPerm) {
        // Check for valid approved AccessRequest
        const req = await prisma.accessRequest.findFirst({
          where: {
            requesterId: user.id,
            serverId: id,
            type: "password_reveal",
            status: "approved",
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        });
        if (!req) return c.json({ error: { code: "FORBIDDEN", message: "Request access to reveal this password" } }, 403);
      }

      const password = await revealServerPassword(id, getAuditCtx(c));
      return c.json({ password });
    },
  )

  // GET /servers/:id/status-history
  .get(
    "/:id/status-history",
    zValidator("param", idParamSchema),
    zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      return c.json(await getStatusHistory(id, limit));
    },
  )

  // POST /servers/:id/check — manual single probe
  .post(
    "/:id/check",
    requirePermission({ server: ["check"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const result = await runCheck(id);
      if (!result) return c.json({ error: { code: "NOT_FOUND", message: "Server not found" } }, 404);
      return c.json(result);
    },
  )

  // POST /servers/check-all — probe all servers
  .post(
    "/check-all",
    requirePermission({ server: ["check"] }),
    async (c) => {
      const results = await runAll();
      return c.json({ checked: results.length });
    },
  )

  // GET /servers/:id/metrics — live resource snapshot via agentless SSH (editor+)
  .get(
    "/:id/metrics",
    requirePermission({ server: ["metrics"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      if (!env.METRICS_ENABLED) {
        return c.json({ error: { code: "DISABLED", message: "Metrics are disabled" } }, 503);
      }
      const { id } = c.req.valid("param");
      const user = c.get("user");
      try {
        const metrics = await fetchMetrics(id);
        if (shouldAuditMetrics(user.id, id)) {
          await writeAuditDirect({
            ctx: getAuditCtx(c),
            category: "data",
            action: "server.metrics_view",
            entity: "server",
            entityId: String(id),
          });
        }
        return c.json(metrics);
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ reachable: false, message }, status);
      }
    },
  );
