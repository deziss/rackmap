import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env.js";
import { auth } from "./auth.js";
import { onError } from "./lib/errors.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { meRoutes } from "./modules/me/me.routes.js";
import { lookupRoutes } from "./modules/lookups/lookup.routes.js";
import { serverRoutes } from "./modules/servers/server.routes.js";
import { tagRoutes } from "./modules/tags/tag.routes.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { viewRoutes } from "./modules/views/view.routes.js";
import { importRoutes } from "./modules/import-export/import.routes.js";
import { apiKeyRoutes } from "./modules/api-keys/api-key.routes.js";

export function createApp() {
  const app = new Hono();

  app.use(logger());
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Better Auth handler — handles /api/auth/* paths
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

  app.onError(onError);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
