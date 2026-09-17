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
import { autoDiscoverAndApply } from "../../services/discovery.service.js";
import { listOsUsers, updateSudoPermission } from "../../services/os-user.service.js";
import { queryServerLogs } from "../../services/log-viewer.service.js";
import { getAtopDates, getAtopSnapshots, getAtopIntervalProcesses } from "../../services/atop.service.js";
import { getAutoUpdateStatus, updateAutoUpdateStatus } from "../../services/auto-update.service.js";
import { testServerSshKey } from "../../services/ssh-key.service.js";
import { SudoPermissionInput, LogQueryInput, AtopQueryInput, AutoUpdateActionInput } from "@inv/shared";
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

function getSessionToken(c: any): string {
  const cookies = c.req.header("cookie") || "";
  const match = cookies.match(/better-auth\.session_token=([^;]+)/);
  if (match) return match[1];
  return c.get("session")?.token || "anonymous";
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
      const token = getSessionToken(c);
      const dto = await createServer(input, getAuditCtx(c), token);
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
      const token = getSessionToken(c);
      return c.json(await updateServer(id, input, getAuditCtx(c), token));
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

      const token = getSessionToken(c);
      try {
        const password = await revealServerPassword(id, getAuditCtx(c), token);
        return c.json({ password });
      } catch (err: any) {
        if (err.message?.includes("Vault is locked")) {
          return c.json({ error: { code: "VAULT_LOCKED", message: err.message } }, 423);
        }
        throw err;
      }
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
        return c.json({ error: { code: "SSH_ERROR", message } }, status);
      }
    },
  )
  // POST /servers/:id/auto-discover — agentless remote hardware discovery
  .post(
    "/:id/auto-discover",
    requirePermission({ server: ["discover"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const info = await autoDiscoverAndApply(id, getAuditCtx(c));
        return c.json(info);
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "DISCOVERY_ERROR", message } }, status);
      }
    },
  )

  // GET /servers/:id/os-users — list OS users with home dirs and sudo status
  .get(
    "/:id/os-users",
    requirePermission({ server: ["osUsers"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const users = await listOsUsers(id);
        return c.json({ users });
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "OS_USERS_ERROR", message } }, status);
      }
    },
  )

  // POST /servers/:id/os-users/sudo — configure sudoers permission for OS user
  .post(
    "/:id/os-users/sudo",
    requirePermission({ server: ["sudo"] }),
    zValidator("param", idParamSchema),
    zValidator("json", SudoPermissionInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      try {
        const result = await updateSudoPermission(id, input, getAuditCtx(c));
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: { code: "SUDO_CONFIG_ERROR", message: err.message } }, 400);
      }
    },
  )

  // POST /servers/:id/logs — query system logs with filters
  .post(
    "/:id/logs",
    requirePermission({ server: ["logs"] }),
    zValidator("param", idParamSchema),
    zValidator("json", LogQueryInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      try {
        const response = await queryServerLogs(id, input);
        return c.json(response);
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "LOG_QUERY_ERROR", message } }, status);
      }
    },
  )

  // GET /servers/:id/atop/dates — list available atop archive dates
  .get(
    "/:id/atop/dates",
    requirePermission({ server: ["atop"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const res = await getAtopDates(id);
        return c.json(res);
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "ATOP_ERROR", message } }, status);
      }
    },
  )

  // POST /servers/:id/atop/snapshots — query interval snapshots with metric filters & spike flags
  .post(
    "/:id/atop/snapshots",
    requirePermission({ server: ["atop"] }),
    zValidator("param", idParamSchema),
    zValidator("json", AtopQueryInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      try {
        const res = await getAtopSnapshots(id, input);
        return c.json(res);
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "ATOP_ERROR", message } }, status);
      }
    },
  )

  // POST /servers/:id/atop/interval-processes — get top processes for specific interval
  .post(
    "/:id/atop/interval-processes",
    requirePermission({ server: ["atop"] }),
    zValidator("param", idParamSchema),
    zValidator("json", z.object({ date: z.string(), time: z.string() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { date, time } = c.req.valid("json");
      try {
        const procs = await getAtopIntervalProcesses(id, date, time);
        return c.json({ processes: procs });
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "ATOP_ERROR", message } }, status);
      }
    },
  )

  // GET /servers/:id/auto-update — check unattended-upgrades status & log snippet
  .get(
    "/:id/auto-update",
    requirePermission({ server: ["read"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const res = await getAutoUpdateStatus(id);
        return c.json(res);
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "AUTO_UPDATE_ERROR", message } }, status);
      }
    },
  )

  // POST /servers/:id/auto-update — enable, disable, or remove unattended-upgrades
  .post(
    "/:id/auto-update",
    requirePermission({ server: ["update"] }),
    zValidator("param", idParamSchema),
    zValidator("json", AutoUpdateActionInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      try {
        const res = await updateAutoUpdateStatus(id, input);
        return c.json(res);
      } catch (err: any) {
        return c.json({ error: { code: "AUTO_UPDATE_ERROR", message: err.message } }, 400);
      }
    },
  )

  // POST /servers/:id/ssh-keys/test — test SSH key connectivity for this specific server
  .post(
    "/:id/ssh-keys/test",
    requirePermission({ server: ["read"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const res = await testServerSshKey(id);
      return c.json(res);
    },
  );
