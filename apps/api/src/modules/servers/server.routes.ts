import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { revealPasswordResourceLimit, revealPasswordUserLimit } from "../../middleware/rate-limit.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import { notFound } from "../../lib/errors.js";
import { can } from "../../lib/permissions.js";
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
import { notifyFlip } from "../../services/notify.service.js";
import { fetchMetrics } from "../../services/metrics.service.js";
import { autoDiscoverAndApply, formatStorageBytes } from "../../services/discovery.service.js";
import {
  listOsUsers,
  updateSudoPermission,
  createOsUser,
  updateOsUser,
  deleteOsUser,
  grantsPrivilegedAccess,
  osUserErrorToHttp,
  PRIVILEGED_GRANT_MESSAGE,
} from "../../services/os-user.service.js";
import { queryServerLogs } from "../../services/log-viewer.service.js";
import { getAtopDates, getAtopSnapshots, getAtopIntervalProcesses, getAtopTopProcesses } from "../../services/atop.service.js";
import { getAutoUpdateStatus, updateAutoUpdateStatus } from "../../services/auto-update.service.js";
import { testServerSshKey } from "../../services/ssh-key.service.js";
import { SudoPermissionInput, CreateOsUserInput, UpdateOsUserInput, DeleteOsUserInput, LogQueryInput, AtopQueryInput, AtopTopProcessesInput, AtopIntervalProcessesInput, AutoUpdateActionInput } from "@inv/shared";
import { sshErrorToHttp } from "../../services/ssh.service.js";
import { env } from "../../env.js";
import { prisma } from "../../db.js";
import { assertCanAddServer, assertFeatureEnabled } from "../../services/license.service.js";

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
      await assertCanAddServer();
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

  // POST /servers/:id/reveal-password — server:revealPassword OR approved AccessRequest
  //
  // Rate limited: 5 per server and 20 overall per user per 5 minutes. The
  // per-server limiter runs first so requests it rejects do not also consume
  // the fleet-wide budget. See middleware/rate-limit.ts for the reasoning.
  .post(
    "/:id/reveal-password",
    zValidator("param", idParamSchema),
    revealPasswordResourceLimit,
    revealPasswordUserLimit,
    async (c) => {
      const user = c.get("user") as { id?: string; role?: string } | undefined;
      if (!user?.id) return c.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
      const { id } = c.req.valid("param");

      // Ask the RBAC single source of truth rather than hardcoding role names,
      // so editing a role in @inv/shared cannot silently desync this check.
      const hasDirectPerm = can(user.role ?? "viewer", "server", "revealPassword");
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
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const metrics = await fetchMetrics(id, sshPass);
        // Auto-calculate and store total storage if currently missing in database
        if (metrics.disks && metrics.disks.length > 0) {
          try {
            const current = await prisma.server.findUnique({ where: { id }, select: { disk: true } });
            if (current && !current.disk) {
              const totalBytes = metrics.disks.reduce((acc, d) => acc + (d.totalBytes || 0), 0);
              if (totalBytes > 0) {
                await prisma.server.update({ where: { id }, data: { disk: formatStorageBytes(totalBytes) } });
              }
            }
          } catch {}
        }
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
  // POST /servers/:id/recalculate-storage — calculate and store total storage
  .post(
    "/:id/recalculate-storage",
    requirePermission({ server: ["update"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const server = await prisma.server.findUnique({ where: { id } });
      if (!server || server.deletedAt) throw notFound("Server");

      let calculatedStorage: string | null = null;
      if (server.passwordEnc) {
        try {
          const info = await autoDiscoverAndApply(id, getAuditCtx(c));
          if (info.totalStorage) calculatedStorage = info.totalStorage;
        } catch {
          try {
            const metrics = await fetchMetrics(id);
            if (metrics.disks.length > 0) {
              const totalBytes = metrics.disks.reduce((acc, d) => acc + (d.totalBytes || 0), 0);
              if (totalBytes > 0) calculatedStorage = formatStorageBytes(totalBytes);
            }
          } catch {}
        }
      }

      if (calculatedStorage) {
        await prisma.server.update({ where: { id }, data: { disk: calculatedStorage } });
        await writeAuditDirect({
          ctx: getAuditCtx(c),
          category: "data",
          action: "server.recalculate_storage",
          entity: "Server",
          entityId: String(id),
          before: { disk: server.disk },
          after: { disk: calculatedStorage },
        });
      }

      const updated = await getServer(id);
      return c.json({ server: updated, totalStorage: calculatedStorage || updated.disk });
    },
  )

  // POST /servers/:id/auto-discover — agentless remote hardware discovery
  .post(
    "/:id/auto-discover",
    requirePermission({ server: ["discover"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      await assertFeatureEnabled("hardware_discovery");
      const { id } = c.req.valid("param");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const info = await autoDiscoverAndApply(id, getAuditCtx(c), sshPass);
        const server = await getServer(id);
        return c.json({ server, hardware: info, ...info });
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
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const users = await listOsUsers(id, sshPass);
        return c.json({ users });
      } catch (err) {
        const { status, message, code } = sshErrorToHttp(err);
        return c.json({ error: { code: code ?? "OS_USERS_ERROR", message } }, status);
      }
    },
  )

  // POST /servers/:id/os-users — create new OS user
  //
  // server:osUsers (editor) may create plain accounts. A sudo grant or a
  // root-equivalent group is a privilege grant and additionally needs the
  // admin-only server:sudo. This check runs before the license check and before
  // any SSH connection, so it never depends on the target host.
  .post(
    "/:id/os-users",
    requirePermission({ server: ["osUsers"] }),
    zValidator("param", idParamSchema),
    zValidator("json", CreateOsUserInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const canSudo = can(c.get("user").role, "server", "sudo");
      if (!canSudo && grantsPrivilegedAccess(input)) {
        return c.json({ error: { code: "FORBIDDEN", message: PRIVILEGED_GRANT_MESSAGE } }, 403);
      }
      await assertFeatureEnabled("remote_os_users");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const result = await createOsUser(id, input, getAuditCtx(c), sshPass, { allowPrivileged: canSudo });
        return c.json(result, 201);
      } catch (err) {
        const { status, code, message } = osUserErrorToHttp(err, "OS_USER_CREATE_ERROR");
        return c.json({ error: { code, message } }, status);
      }
    },
  )

  // PATCH /servers/:id/os-users/:username — update OS user
  //
  // Same privilege rule as POST for the body. Without server:sudo the service
  // also refuses, on the host, any change to an account that is already
  // root-equivalent (resetting a sudo user's password is a sudo grant).
  .patch(
    "/:id/os-users/:username",
    requirePermission({ server: ["osUsers"] }),
    zValidator("param", z.object({ id: z.coerce.number().int().positive(), username: z.string().min(1) })),
    zValidator("json", UpdateOsUserInput),
    async (c) => {
      const { id, username } = c.req.valid("param");
      const input = c.req.valid("json");
      const canSudo = can(c.get("user").role, "server", "sudo");
      if (!canSudo && grantsPrivilegedAccess(input)) {
        return c.json({ error: { code: "FORBIDDEN", message: PRIVILEGED_GRANT_MESSAGE } }, 403);
      }
      await assertFeatureEnabled("remote_os_users");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const result = await updateOsUser(id, username, input, getAuditCtx(c), sshPass, { allowPrivileged: canSudo });
        return c.json(result);
      } catch (err) {
        const { status, code, message } = osUserErrorToHttp(err, "OS_USER_UPDATE_ERROR");
        return c.json({ error: { code, message } }, status);
      }
    },
  )

  // DELETE /servers/:id/os-users/:username — delete OS user
  .delete(
    "/:id/os-users/:username",
    requirePermission({ server: ["osUsers"] }),
    zValidator("param", z.object({ id: z.coerce.number().int().positive(), username: z.string().min(1) })),
    zValidator("query", DeleteOsUserInput),
    async (c) => {
      const { id, username } = c.req.valid("param");
      const input = c.req.valid("query");
      const canSudo = can(c.get("user").role, "server", "sudo");
      await assertFeatureEnabled("remote_os_users");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const result = await deleteOsUser(id, username, input, getAuditCtx(c), sshPass, { allowPrivileged: canSudo });
        return c.json(result);
      } catch (err) {
        const { status, code, message } = osUserErrorToHttp(err, "OS_USER_DELETE_ERROR");
        return c.json({ error: { code, message } }, status);
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
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const result = await updateSudoPermission(id, input, getAuditCtx(c), sshPass);
        return c.json(result);
      } catch (err) {
        const { status, code, message } = osUserErrorToHttp(err, "SUDO_CONFIG_ERROR");
        return c.json({ error: { code, message } }, status);
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
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const response = await queryServerLogs(id, input, sshPass);
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
      await assertFeatureEnabled("atop_history");
      const { id } = c.req.valid("param");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const res = await getAtopDates(id, sshPass);
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
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const res = await getAtopSnapshots(id, input, sshPass);
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
    zValidator("json", AtopIntervalProcessesInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const { date, time } = c.req.valid("json");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const procs = await getAtopIntervalProcesses(id, date, time, sshPass);
        return c.json({ processes: procs });
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "ATOP_ERROR", message } }, status);
      }
    },
  )

    // POST /servers/:id/atop/top-processes — get top 5 processes for cpu, mem, dsk, net for date or interval
  .post(
    "/:id/atop/top-processes",
    requirePermission({ server: ["atop"] }),
    zValidator("param", idParamSchema),
    zValidator("json", AtopTopProcessesInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const { date, time } = c.req.valid("json");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const topProcesses = await getAtopTopProcesses(id, date, time, sshPass);
        return c.json({ date, time: time || null, topProcesses });
      } catch (err) {
        const { status, message } = sshErrorToHttp(err);
        return c.json({ error: { code: "ATOP_ERROR", message } }, status);
      }
    },
  )

  // GET /servers/:id/auto-update — check unattended-upgrades status & log snippet
  .get(
    "/:id/auto-update",
    requirePermission({ server: ["update"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const res = await getAutoUpdateStatus(id, sshPass);
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
      await assertFeatureEnabled("auto_update");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      try {
        const sshPass = c.req.header("x-ssh-password") || undefined;
        const res = await updateAutoUpdateStatus(id, input, sshPass);
        await writeAuditDirect({
          ctx: getAuditCtx(c),
          category: "data",
          action: "server.auto_update_change",
          entity: "Server",
          entityId: String(id),
          after: { action: input.action },
        });
        return c.json(res);
      } catch (err: any) {
        // `err.message` here can carry remote shell stderr — keep it out of the response.
        return c.json({ error: { code: "AUTO_UPDATE_ERROR", message: "Failed to apply auto-update configuration" } }, 400);
      }
    },
  )

  // POST /servers/:id/ssh-keys/test — test SSH key connectivity for this specific server
  .post(
    "/:id/ssh-keys/test",
    requirePermission({ server: ["check"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const res = await testServerSshKey(id);
      return c.json(res);
    },
  )

  // GET /servers/:id/alert-channels — check configured alert notification dispatchers
  .get(
    "/:id/alert-channels",
    requirePermission({ server: ["update"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      return c.json({
        webhook: {
          configured: !!env.NOTIFY_WEBHOOK_URL,
          urlMasked: env.NOTIFY_WEBHOOK_URL ? env.NOTIFY_WEBHOOK_URL.replace(/(https?:\/\/[^/]+\/).+/, "$1***") : null,
        },
        telegram: {
          configured: !!(env.NOTIFY_TELEGRAM_BOT_TOKEN && env.NOTIFY_TELEGRAM_CHAT_ID),
          chatId: env.NOTIFY_TELEGRAM_CHAT_ID || null,
        },
        email: {
          configured: !!env.SMTP_HOST,
          host: env.SMTP_HOST || null,
        },
      });
    },
  )

  // POST /servers/:id/test-alert — dispatch a test probe alert to configured channels
  .post(
    "/:id/test-alert",
    requirePermission({ server: ["update"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const server = await prisma.server.findUnique({
        where: { id },
        select: { id: true, hostname: true, ip: true, sshPort: true },
      });
      if (!server) return c.json({ error: { code: "NOT_FOUND", message: "Server not found" } }, 404);

      await notifyFlip({
        serverId: server.id,
        hostname: server.hostname,
        ip: server.ip,
        port: server.sshPort,
        from: "test_probe",
        to: "alert_verification",
      });

      return c.json({
        success: true,
        message: `Test alert dispatched to configured channels for ${server.hostname} (${server.ip})`,
        channels: {
          webhook: !!env.NOTIFY_WEBHOOK_URL,
          telegram: !!(env.NOTIFY_TELEGRAM_BOT_TOKEN && env.NOTIFY_TELEGRAM_CHAT_ID),
          email: !!env.SMTP_HOST,
        },
      });
    },
  );
