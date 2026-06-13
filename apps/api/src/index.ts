import "./env.js"; // validate env at boot
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { createApp } from "./app.js";
import { startScheduler } from "./services/scheduler.js";
import { scheduleBackup } from "./services/backup.service.js";
import { setupWebSocket } from "./ws/ssh.ws.js";
import type { Server } from "node:http";

async function main() {
  // WAL mode — prevents SQLITE_BUSY under concurrent probe writes
  if (env.DATABASE_URL.startsWith("file:")) {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  }

  const app = createApp();

  // Mount WebSocket route before catch-all
  const injectWebSocket = setupWebSocket(app);

  if (env.SERVE_STATIC_DIR) {
    app.use("/*", serveStatic({ root: env.SERVE_STATIC_DIR }));
  }

  const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
    startScheduler();
    scheduleBackup();
  });

  injectWebSocket(server as unknown as Server);
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
