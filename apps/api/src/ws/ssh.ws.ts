import type { Hono } from "hono";
import type { Server } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import type { ClientChannel } from "ssh2";
import { auth } from "../auth.js";
import { env } from "../env.js";
import { can } from "../lib/permissions.js";
import { getClientIp } from "../middleware/session.js";
import { writeAuditDirect } from "../lib/audit.js";
import { connectToServer, sshErrorToHttp, type SshTarget } from "../services/ssh.service.js";
import type { Client } from "ssh2";
import { prisma } from "../db.js";

// Global + per-user concurrency caps for an RCE-capable feature.
let activeCount = 0;
const perUser = new Map<string, number>();
const enc = new TextEncoder();

/**
 * Mount the SSH-terminal WebSocket route and return the injector that must be
 * called with the Node http.Server after `serve()`. Auth + RBAC are enforced
 * in the upgrade factory BEFORE any SSH connection is attempted.
 */
export function setupWebSocket(app: Hono): (server: Server) => void {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    "/api/v1/servers/:id/ssh",
    upgradeWebSocket(async (c) => {
      const id = Number(c.req.param("id"));
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const user = session?.user as { id: string; email: string; role?: string | null; banned?: boolean | null } | undefined;
      const role = user?.role ?? "viewer";
      const ip = getClientIp(c);

      // Admin has direct SSH permission; viewers/editors need an approved AccessRequest
      const hasSshPerm = can(role, "server", "ssh");
      let authorizedViaRequest = false;
      if (!hasSshPerm && !!user && !user.banned && Number.isFinite(id)) {
        const req = await prisma.accessRequest.findFirst({
          where: {
            requesterId: user.id,
            serverId: id,
            type: "ssh",
            status: "approved",
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        });
        authorizedViaRequest = !!req;
      }

      const authorized =
        env.SSH_ENABLED &&
        !!user &&
        !user.banned &&
        Number.isFinite(id) &&
        (hasSshPerm || authorizedViaRequest);

      if (!authorized) {
        return { onOpen: (_e, ws) => ws.close(1008, "unauthorized") };
      }
      const actor = user!;

      // Per-connection state (this factory runs once per socket).
      let client: Client | null = null;
      let stream: ClientChannel | null = null;
      let target: SshTarget | null = null;
      let startedAt = 0;
      let counted = false;
      let cleanedUp = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let maxTimer: ReturnType<typeof setTimeout> | undefined;

      const ctx = { actorId: actor.id, actorEmail: actor.email, ip };

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (maxTimer) clearTimeout(maxTimer);
        try { stream?.end(); } catch { /* noop */ }
        try { client?.end(); } catch { /* noop */ }
        if (counted) {
          activeCount = Math.max(0, activeCount - 1);
          perUser.set(actor.id, Math.max(0, (perUser.get(actor.id) ?? 1) - 1));
          counted = false;
        }
        if (startedAt > 0) {
          const durationMs = Date.now() - startedAt;
          void writeAuditDirect({
            ctx,
            category: "data",
            action: "server.ssh_close",
            entity: "server",
            entityId: String(id),
            after: { durationMs, hostname: target?.hostname ?? null },
          });
        }
      };

      return {
        onOpen: async (_evt, ws) => {
          const userActive = perUser.get(actor.id) ?? 0;
          if (activeCount >= env.SSH_MAX_CONCURRENT || userActive >= env.SSH_MAX_CONCURRENT) {
            ws.send(enc.encode("\r\n*** Too many active SSH sessions — try again later ***\r\n"));
            ws.close(1013, "too many sessions");
            return;
          }
          activeCount++;
          perUser.set(actor.id, userActive + 1);
          counted = true;

          try {
            const conn = await connectToServer(id);
            client = conn.client;
            target = conn.target;
          } catch (err) {
            const { message } = sshErrorToHttp(err);
            ws.send(enc.encode(`\r\n*** ${message} ***\r\n`));
            ws.close(1011, "ssh connect failed");
            cleanup();
            return;
          }

          client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (err, st) => {
            if (err || !client) {
              ws.send(enc.encode("\r\n*** Failed to open shell ***\r\n"));
              ws.close(1011, "shell failed");
              cleanup();
              return;
            }
            stream = st;
            startedAt = Date.now();

            void writeAuditDirect({
              ctx,
              category: "data",
              action: "server.ssh_open",
              entity: "server",
              entityId: String(id),
              after: { hostname: target?.hostname ?? null },
            });

            resetIdle(ws);
            maxTimer = setTimeout(() => ws.close(4001, "max session duration"), env.SSH_MAX_SESSION_MS);

            st.on("data", (d: Buffer) => ws.send(new Uint8Array(d)));
            st.stderr.on("data", (d: Buffer) => ws.send(new Uint8Array(d)));
            st.on("close", () => ws.close(1000, "shell closed"));
          });
        },

        onMessage: (evt, ws) => {
          resetIdle(ws);
          if (typeof evt.data !== "string" || !stream) return;
          let msg: { t?: string; d?: string; c?: number; r?: number };
          try { msg = JSON.parse(evt.data); } catch { return; }
          if (msg.t === "d" && typeof msg.d === "string") {
            stream.write(msg.d);
          } else if (msg.t === "r") {
            stream.setWindow(Number(msg.r) || 24, Number(msg.c) || 80, 0, 0);
          }
        },

        onClose: () => cleanup(),
        onError: () => cleanup(),
      };

      function resetIdle(ws: { close: (code?: number, reason?: string) => void }) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ws.close(4000, "idle timeout"), env.SSH_IDLE_TIMEOUT_MS);
      }
    }),
  );

  return injectWebSocket;
}
