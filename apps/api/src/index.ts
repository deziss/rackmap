import "./env.js"; // validate env at boot
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { createApp } from "./app.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { scheduleBackup, stopBackup } from "./services/backup.service.js";
import { setupWebSocket } from "./ws/ssh.ws.js";
import { startAlertScheduler, stopAlertScheduler } from "./services/alert.service.js";
import { autoInitVaultFromEnv } from "./services/vault.service.js";
import { autoInitLicenseFromEnv } from "./services/license.service.js";
import type { Server } from "node:http";

async function main() {
  // Auto-initialize or unlock Master Credential Vault if VAULT_PASSPHRASE is configured in .env
  await autoInitVaultFromEnv();

  // Auto-initialize Licencia license if LICENCIA_LICENSE_KEY is configured in .env
  await autoInitLicenseFromEnv();

  const app = createApp();

  // Mount WebSocket route before catch-all
  const injectWebSocket = setupWebSocket(app);

  if (env.SERVE_STATIC_DIR) {
    app.use("/*", serveStatic({ root: env.SERVE_STATIC_DIR }));
  }

  const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
    startScheduler();
    startAlertScheduler();
    scheduleBackup();
  });

  injectWebSocket(server as unknown as Server);

  // Stop background work, then close the listener and the DB pool.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received`);
    stopScheduler();
    stopBackup();
    stopAlertScheduler();
    (server as unknown as Server).close();
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
