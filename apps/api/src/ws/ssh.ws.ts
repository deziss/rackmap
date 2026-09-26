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
 * How many failed SSH credential submissions a single socket may make before it
 * is closed. Without this the handler re-prompted forever: `resetIdle()` fires on
 * every inbound message so the idle timer never expired during guessing, and the
 * only bound was SSH_MAX_SESSION_MS — after which the client simply reconnected.
 */
const MAX_SSH_AUTH_ATTEMPTS = 5;

type SessionUser = { id: string; email: string; role?: string | null; banned?: boolean | null };

/** Result of an authorization evaluation — ok, or why not. */
type AuthzResult = { ok: true; user: SessionUser } | { ok: false; reason: string };

/**
 * Evaluate, from scratch, whether the holder of these request headers may hold an
 * SSH terminal on server `id`.
 *
 * Self-sufficient ON PURPOSE. This route only inherits `requireSession` by accident
 * of Hono mount ordering — `app.route("/api/v1/servers", serverRoutes)` in app.ts
 * replays that middleware as `ALL /api/v1/servers/*`, and `setupWebSocket(app)` runs
 * later in index.ts, so the upgrade lands underneath it. Reordering those two calls,
 * or moving this route, would silently remove the session check. Nothing below reads
 * `c.get("user")` or any other middleware-populated context: the session is resolved
 * here directly, so the route is safe regardless of mount order.
 *
 * It is also re-run periodically for the lifetime of the socket (see
 * SSH_REAUTH_INTERVAL_MS) so a ban, a role downgrade, a revoked session or an expired
 * AccessRequest tears the live root terminal down instead of surviving until
 * SSH_MAX_SESSION_MS.
 */
async function evaluateAuthorization(headers: Headers, id: number): Promise<AuthzResult> {
  if (!env.SSH_ENABLED) return { ok: false, reason: "ssh disabled" };
  if (!Number.isFinite(id)) return { ok: false, reason: "invalid server id" };

  const session = await auth.api.getSession({ headers });
  const user = session?.user as SessionUser | undefined;
  if (!user) return { ok: false, reason: "session expired" };
  if (user.banned) return { ok: false, reason: "account banned" };

  const role = user.role ?? "viewer";
  // Admin has direct SSH permission; viewers/editors need an approved AccessRequest.
  if (can(role, "server", "ssh")) return { ok: true, user };

  const req = await prisma.accessRequest.findFirst({
    where: {
      requesterId: user.id,
      serverId: id,
      type: "ssh",
      status: "approved",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (req) return { ok: true, user };

  return { ok: false, reason: "ssh access no longer granted" };
}

/**
 * Mount the SSH-terminal WebSocket route and return the injector that must be
 * called with the Node http.Server after `serve()`. Auth + RBAC are enforced
 * in the upgrade factory BEFORE any SSH connection is attempted, and re-checked
 * on an interval for as long as the socket lives.
 */
export function setupWebSocket(app: Hono): (server: Server) => void {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    "/api/v1/servers/:id/ssh",
    upgradeWebSocket(async (c) => {
      const id = Number(c.req.param("id"));
      // Captured once at upgrade: the cookie jar the socket was opened with. The
      // periodic re-check resolves the session from these same headers, so a
      // revoked/expired session stops validating.
      const reqHeaders = c.req.raw.headers;
      const ip = getClientIp(c);

      const initial = await evaluateAuthorization(reqHeaders, id);
      if (!initial.ok) {
        return { onOpen: (_e, ws) => ws.close(1008, "unauthorized") };
      }
      const actor = initial.user;

      // Per-connection state (this factory runs once per socket).
      let client: Client | null = null;
      let stream: ClientChannel | null = null;
      let target: SshTarget | null = null;
      let startedAt = 0;
      let counted = false;
      let cleanedUp = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let maxTimer: ReturnType<typeof setTimeout> | undefined;
      let reauthTimer: ReturnType<typeof setInterval> | undefined;
      // Two-phase connect: set to true when we're waiting for the client to send a password
      let waitingForPassword = false;
      // Failed SSH credential submissions on this socket (stored creds + every
      // password the client supplied afterwards).
      let authAttempts = 0;
      let closeReason: string | null = null;

      const ctx = { actorId: actor.id, actorEmail: actor.email, ip };

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (reauthTimer) clearInterval(reauthTimer);
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
            after: { durationMs, hostname: target?.hostname ?? null, reason: closeReason },
          });
        }
      };

      function resetIdle(ws: { close: (code?: number, reason?: string) => void }) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          closeReason = "idle timeout";
          ws.close(4000, "idle timeout");
        }, env.SSH_IDLE_TIMEOUT_MS);
      }

      /** Record a failed SSH credential submission. Returns true if the cap is now spent. */
      function recordAuthFailure(detail: string): boolean {
        authAttempts++;
        const exhausted = authAttempts >= MAX_SSH_AUTH_ATTEMPTS;
        void writeAuditDirect({
          ctx,
          // "security", not "auth": the "auth" category is RackMap sign-in events
          // (app.ts). This is a credential failure against a managed host, and it
          // belongs next to ssh_key.*/api_key.* in the security view.
          category: "security",
          action: "server.ssh_auth_failed",
          entity: "server",
          entityId: String(id),
          after: {
            attempt: authAttempts,
            limit: MAX_SSH_AUTH_ATTEMPTS,
            blocked: exhausted,
            detail,
            hostname: target?.hostname ?? null,
          },
        });
        return exhausted;
      }

      /**
       * Re-run the full authorization check. Cheap and coarse on purpose: once per
       * SSH_REAUTH_INTERVAL_MS, never per keystroke.
       */
      function startReauthLoop(ws: { send: (data: any) => void; close: (code?: number, reason?: string) => void }) {
        reauthTimer = setInterval(() => {
          void evaluateAuthorization(reqHeaders, id)
            .then((res) => {
              if (cleanedUp) return;
              if (res.ok && res.user.id === actor.id) return;
              const reason = res.ok ? "session identity changed" : res.reason;
              closeReason = `deauthorized: ${reason}`;
              try {
                ws.send(enc.encode(`\r\n*** SSH session terminated — ${reason} ***\r\n`));
              } catch { /* socket may already be gone */ }
              ws.close(4002, "deauthorized");
              cleanup();
            })
            .catch(() => {
              // Fail closed: if we cannot prove the operator is still authorized,
              // we do not keep a live root shell open on their behalf.
              if (cleanedUp) return;
              closeReason = "deauthorized: authorization check failed";
              ws.close(4002, "deauthorized");
              cleanup();
            });
        }, env.SSH_REAUTH_INTERVAL_MS);
        // Never hold the process open for a re-check.
        reauthTimer.unref?.();
      }

      // Shared shell-open logic used from both onOpen (stored creds) and
      // onMessage (client-supplied password after need_password prompt).
      function openShell(conn: { client: Client; target: SshTarget }, ws: { send: (data: any) => void; close: (code?: number, reason?: string) => void }) {
        client = conn.client;
        target = conn.target;

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
          // Restart the hard cap from the moment the shell actually opens. onOpen
          // already armed one so a socket that never reaches a shell is bounded too.
          if (maxTimer) clearTimeout(maxTimer);
          maxTimer = setTimeout(() => {
            closeReason = "max session duration";
            ws.close(4001, "max session duration");
          }, env.SSH_MAX_SESSION_MS);

          st.on("data", (d: Buffer) => ws.send(new Uint8Array(d)));
          st.stderr.on("data", (d: Buffer) => ws.send(new Uint8Array(d)));
          st.on("close", () => ws.close(1000, "shell closed"));
        });
      }

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

          // Bound the socket from the moment it opens, not from the moment a shell
          // appears: a client that never authenticates otherwise had no hard cap at
          // all (openShell was the only place that armed maxTimer).
          maxTimer = setTimeout(() => {
            closeReason = "max session duration";
            ws.close(4001, "max session duration");
          }, env.SSH_MAX_SESSION_MS);
          // Arm the idle timer before the shell exists too, so a socket sitting on a
          // "need_password" prompt that nobody answers is reaped in SSH_IDLE_TIMEOUT_MS
          // rather than lingering for the full SSH_MAX_SESSION_MS.
          resetIdle(ws);
          startReauthLoop(ws);

          try {
            const conn = await connectToServer(id);
            openShell(conn, ws);
          } catch (err) {
            const { message } = sshErrorToHttp(err);
            // For credential errors, prompt the client for a password instead of closing.
            // The WS stays open; the client sends {"t":"p","p":"..."} to retry.
            if (err instanceof Error && "kind" in err && (err as { kind: string }).kind === "no_credentials") {
              waitingForPassword = true;
              ws.send(JSON.stringify({ t: "need_password", message: "No password stored. Enter SSH password:" }));
            } else if (err instanceof Error && "kind" in err && (err as { kind: string }).kind === "vault_locked") {
              // The stored password exists but cannot be decrypted right now. A
              // typed password bypasses the vault entirely (connectToServer override).
              waitingForPassword = true;
              ws.send(
                JSON.stringify({
                  t: "need_password",
                  message: "The vault is locked, so the stored password is unavailable. Enter SSH password:",
                }),
              );
            } else if (err instanceof Error && "kind" in err && (err as { kind: string }).kind === "auth_failed") {
              if (recordAuthFailure("stored credentials rejected")) {
                ws.send(JSON.stringify({ t: "auth_error", message: "Too many failed SSH authentication attempts." }));
                closeReason = "too many auth attempts";
                ws.close(4003, "too many auth attempts");
                cleanup();
                return;
              }
              waitingForPassword = true;
              ws.send(
                JSON.stringify({
                  t: "need_password",
                  message: `Authentication failed. Enter SSH password (${MAX_SSH_AUTH_ATTEMPTS - authAttempts} attempt(s) left):`,
                }),
              );
            } else {
              ws.send(enc.encode(`\r\n*** ${message} ***\r\n`));
              closeReason = "ssh connect failed";
              ws.close(1011, "ssh connect failed");
              cleanup();
            }
            return;
          }
        },

        onMessage: async (evt, ws) => {
          if (typeof evt.data !== "string") return;
          let msg: { t?: string; d?: string; c?: number; r?: number; p?: string };
          try { msg = JSON.parse(evt.data); } catch { return; }

          // Two-phase connect: client is supplying a password
          if (waitingForPassword && msg.t === "p" && typeof msg.p === "string") {
            resetIdle(ws);
            waitingForPassword = false;
            try {
              const conn = await connectToServer(id, msg.p);
              openShell(conn, ws);
            } catch (err) {
              const { message } = sshErrorToHttp(err);
              // Allow retry on auth failure — but only within the attempt budget.
              if (err instanceof Error && "kind" in err && (err as { kind: string }).kind === "auth_failed") {
                if (recordAuthFailure("client-supplied password rejected")) {
                  ws.send(
                    JSON.stringify({
                      t: "auth_error",
                      message: `Too many failed SSH authentication attempts (${MAX_SSH_AUTH_ATTEMPTS}). Connection closed.`,
                    }),
                  );
                  closeReason = "too many auth attempts";
                  ws.close(4003, "too many auth attempts");
                  cleanup();
                  return;
                }
                waitingForPassword = true;
                ws.send(
                  JSON.stringify({
                    t: "auth_error",
                    message: `Wrong password — ${MAX_SSH_AUTH_ATTEMPTS - authAttempts} attempt(s) left:`,
                  }),
                );
              } else {
                ws.send(JSON.stringify({ t: "auth_error", message }));
                closeReason = "ssh connect failed";
                ws.close(1011, "ssh connect failed");
                cleanup();
              }
            }
            return;
          }

          if (!stream) return;
          // Only recognized traffic postpones the idle timer. Resetting it for any
          // inbound frame let a client hold a credential-less socket open forever
          // by dribbling junk at it.
          if (msg.t === "d" && typeof msg.d === "string") {
            resetIdle(ws);
            stream.write(msg.d);
          } else if (msg.t === "r") {
            resetIdle(ws);
            stream.setWindow(Number(msg.r) || 24, Number(msg.c) || 80, 0, 0);
          }
        },

        onClose: () => cleanup(),
        onError: () => cleanup(),
      };
    }),
  );

  return injectWebSocket;
}
