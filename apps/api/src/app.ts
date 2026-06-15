import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env.js";
import { auth } from "./auth.js";
import { onError } from "./lib/errors.js";
import { prisma } from "./db.js";
import { writeAuditDirect } from "./lib/audit.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { meRoutes } from "./modules/me/me.routes.js";
import { lookupRoutes } from "./modules/lookups/lookup.routes.js";
import { serverRoutes } from "./modules/servers/server.routes.js";
import { tagRoutes } from "./modules/tags/tag.routes.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { viewRoutes } from "./modules/views/view.routes.js";
import { importRoutes } from "./modules/import-export/import.routes.js";
import { apiKeyRoutes } from "./modules/api-keys/api-key.routes.js";
import { userRoutes } from "./modules/users/user.routes.js";
import { accessRequestRoutes } from "./modules/access-requests/access-request.routes.js";

export function createApp() {
  const app = new Hono();

  app.use(logger());
  // Reflect origin to support any IP/hostname when TRUSTED_ORIGINS=* (internal tool default).
  // With credentials:true, CORS requires an exact origin echo — can't use literal "*".
  const trustedList = env.TRUSTED_ORIGINS === "*" ? null : env.TRUSTED_ORIGINS.split(",").map((o) => o.trim());
  app.use(
    cors({
      origin: trustedList ? trustedList : (origin) => origin,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
    const response = await auth.handler(cloned);
    if (response.status === 200) {
      const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
      if (email) {
        prisma.user.findUnique({ where: { email } }).then((user) => {
          if (user) {
            return writeAuditDirect({
              ctx: { actorId: user.id, actorEmail: user.email, ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null },
              category: "auth",
              action: "auth.sign_in",
              entity: "User",
              entityId: user.id,
            });
          }
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

  // Authenticated app routes
  app.route("/api/v1/me", meRoutes);
  app.route("/api/v1/lookups", lookupRoutes);
  app.route("/api/v1/servers", serverRoutes);
  app.route("/api/v1/tags", tagRoutes);
  app.route("/api/v1/audit", auditRoutes);
  app.route("/api/v1/views", viewRoutes);
  app.route("/api/v1/servers", importRoutes);
  app.route("/api/v1/api-keys", apiKeyRoutes);
  app.route("/api/v1/users", userRoutes);
  app.route("/api/v1/access-requests", accessRequestRoutes);

  app.onError(onError);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
