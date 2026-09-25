import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env.js";
import { auth } from "./auth.js";
import { onError } from "./lib/errors.js";
import { prisma } from "./db.js";
import { writeAuditDirect } from "./lib/audit.js";
import { withVaultSession } from "./lib/vault-context.js";
import { withSudoOverride } from "./lib/sudo-context.js";
import { apiKeyAuth } from "./modules/api-keys/api-key.routes.js";
import { metricsExportRoutes } from "./modules/metrics-export/metrics-export.routes.js";
import { sshHostKeyRoutes } from "./modules/ssh-host-keys/ssh-host-key.routes.js";
import { publicRoutes } from "./modules/public/public.routes.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { meRoutes } from "./modules/me/me.routes.js";
import { lookupRoutes } from "./modules/lookups/lookup.routes.js";
import { serverRoutes } from "./modules/servers/server.routes.js";
import { tagRoutes } from "./modules/tags/tag.routes.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { viewRoutes } from "./modules/views/view.routes.js";
import { importRoutes } from "./modules/import-export/import.routes.js";
import { serviceImportRoutes } from "./modules/import-export/service-import.routes.js";
import { apiKeyRoutes } from "./modules/api-keys/api-key.routes.js";
import { userRoutes } from "./modules/users/user.routes.js";
import { accessRequestRoutes } from "./modules/access-requests/access-request.routes.js";
import { serviceRoutes } from "./modules/services/service.routes.js";
import { sslRoutes } from "./modules/ssl/ssl.routes.js";
import { vaultRoutes } from "./modules/vault/vault.routes.js";
import { sshKeyRoutes } from "./modules/ssh-keys/ssh-key.routes.js";
import { licenseRoutes } from "./modules/license/license.routes.js";
import { checkoutRoutes } from "./modules/checkout/checkout.routes.js";
import { statusHistoryRoutes } from "./modules/status-history/status-history.routes.js";
import { cronRoutes } from "./modules/cron/cron.routes.js";
import { alertChannelRoutes } from "./modules/alert-channels/alert-channel.routes.js";
import { alertEventRoutes } from "./modules/alert-channels/alert-event.routes.js";
import { heartbeatPingRoutes } from "./modules/heartbeats/heartbeat-ping.routes.js";
import { heartbeatRoutes } from "./modules/heartbeats/heartbeat.routes.js";
import { cronMonitorRoutes } from "./modules/heartbeats/cron-monitor.routes.js";
import { runbookRoutes } from "./modules/runbooks/runbook.routes.js";
import { runbookRunRoutes } from "./modules/runbooks/runbook-run.routes.js";

export function createApp() {
  const app = new Hono();

  app.use(logger());
  // Make the caller's vault session token available to code far from the
  // request, so an operator who unlocked only their own session can still open
  // SSH connections. See lib/vault-context.ts.
  app.use(withVaultSession);
  app.use(withSudoOverride);
  // TRUSTED_ORIGINS defaults to WEB_ORIGIN (see env.ts), so an unconfigured deployment is
  // locked to its own web origin. "*" is an explicit opt-in that reflects any IP/hostname back
  // — with credentials:true CORS can't send a literal "*", so the caller's origin is echoed.
  // env.ts emits a boot warning whenever that wildcard is active.
  const trustedList =
    env.TRUSTED_ORIGINS === "*"
      ? null
      : env.TRUSTED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin: trustedList ? trustedList : (origin) => origin,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "X-SSH-Password", "X-Sudo-Password"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Audit sign-in: proxy before the wildcard, clone body so auth.handler can still read it
  app.post("/api/auth/sign-in/email", async (c) => {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const cloned = new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    });
    const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
    const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
    const response = await auth.handler(cloned);
    if (email) {
      if (response.status === 200) {
        prisma.user.findUnique({ where: { email } }).then((user) => {
          if (user) {
            return writeAuditDirect({
              ctx: { actorId: user.id, actorEmail: user.email, ip },
              category: "auth",
              action: "auth.sign_in",
              entity: "User",
              entityId: user.id,
            });
          }
        }).catch(() => {/* non-blocking */});
      } else if (response.status === 401 || response.status === 400) {
        writeAuditDirect({
          ctx: { actorId: null, actorEmail: email, ip },
          category: "auth",
          action: "auth.sign_in_failed",
          entity: "User",
          entityId: undefined,
          after: { email, status: response.status },
        }).catch(() => {/* non-blocking */});
      }
    }
    return response;
  });

  // Audit sign-out: read session before auth.handler invalidates it
  app.post("/api/auth/sign-out", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    const response = await auth.handler(c.req.raw);
    if (response.status === 200 && session?.user) {
      writeAuditDirect({
        ctx: { actorId: session.user.id, actorEmail: session.user.email, ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null },
        category: "auth",
        action: "auth.sign_out",
        entity: "User",
        entityId: session.user.id,
      }).catch(() => {/* non-blocking */});
    }
    return response;
  });

  // Better Auth handler — handles all other /api/auth/* paths
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Health (no auth)
  app.route("/health", healthRoutes);

  // Unauthenticated: what the login screen needs before a session exists.
  app.route("/api/v1/public", publicRoutes);

  // Unauthenticated heartbeat check-ins from cron jobs on managed hosts. The
  // token in the path is the credential. Mounted before apiKeyAuth so a stray
  // Authorization header on a ping can never turn it into a 401.
  app.route("/api/v1/ping", heartbeatPingRoutes);

  // Accept `Authorization: Bearer sk_...` anywhere under /api/v1. This only
  // ATTACHES a user when a valid key is presented; `requireSession` on each
  // route group still decides whether authentication is required, so public
  // routes stay public and cookie traffic is unchanged.
  app.use("/api/v1/*", apiKeyAuth);

  // Authenticated app routes
  app.route("/api/v1/metrics", metricsExportRoutes);
  app.route("/api/v1/me", meRoutes);
  app.route("/api/v1/lookups", lookupRoutes);
  // importRoutes must be before serverRoutes — /export.xlsx and /export.json are
  // specific paths that would otherwise be swallowed by serverRoutes' /:id pattern.
  app.route("/api/v1/servers", importRoutes);
  app.route("/api/v1/servers", serverRoutes);
  app.route("/api/v1/servers", cronRoutes);
  app.route("/api/v1/servers", cronMonitorRoutes);

  // Same for services
  app.route("/api/v1/services", serviceImportRoutes);
  app.route("/api/v1/services", serviceRoutes);

  app.route("/api/v1/tags", tagRoutes);
  app.route("/api/v1/audit", auditRoutes);
  app.route("/api/v1/views", viewRoutes);
  app.route("/api/v1/api-keys", apiKeyRoutes);
  app.route("/api/v1/users", userRoutes);
  app.route("/api/v1/access-requests", accessRequestRoutes);
  app.route("/api/v1/ssl", sslRoutes);
  app.route("/api/v1/vault", vaultRoutes);
  app.route("/api/v1/ssh-keys", sshKeyRoutes);
  app.route("/api/v1/ssh-host-keys", sshHostKeyRoutes);
  app.route("/api/v1/license", licenseRoutes);
  app.route("/api/v1/checkout", checkoutRoutes);
  app.route("/api/v1/status-history", statusHistoryRoutes);
  app.route("/api/v1/alert-channels", alertChannelRoutes);
  app.route("/api/v1/alert-events", alertEventRoutes);
  app.route("/api/v1/heartbeats", heartbeatRoutes);
  app.route("/api/v1/runbooks", runbookRoutes);
  app.route("/api/v1/runbook-runs", runbookRunRoutes);

  app.onError(onError);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
