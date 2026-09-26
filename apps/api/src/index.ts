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
import { startAlertDispatcher, stopAlertDispatcher } from "./services/alerting/dispatcher.js";
import { syncEnvAlertChannels } from "./services/alert-channel.service.js";
import { startSslDailyScan, stopSslDailyScan } from "./services/ssl-daily-scan.js";
import { startHeartbeatScheduler, stopHeartbeatScheduler } from "./services/heartbeat.service.js";
import { startRunbookBackground, stopRunbookBackground } from "./services/runbook-background.js";
import { startPatchScheduler, stopPatchScheduler } from "./services/patch-scheduler.js";
import { startDriftScheduler, stopDriftScheduler } from "./services/drift-scheduler.js";
import { startAccessGrantSweeper, stopAccessGrantSweeper } from "./services/access-grant-sweeper.js";
import { autoInitVaultFromEnv } from "./services/vault.service.js";
import { autoInitLicenseFromEnv } from "./services/license.service.js";
import type { Server } from "node:http";

async function main() {
  // Auto-initialize or unlock Master Credential Vault if VAULT_PASSPHRASE is configured in .env
  await autoInitVaultFromEnv();

  // Auto-initialize Licencia license if LICENCIA_LICENSE_KEY is configured in .env
  await autoInitLicenseFromEnv();

  // Mirror NOTIFY_* env configuration into env-managed alert channels.
  await syncEnvAlertChannels().catch((err) => console.error("[alerts] env channel sync failed:", err));

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
    startAlertDispatcher();
    startSslDailyScan();
    startHeartbeatScheduler();
    startRunbookBackground();
    startPatchScheduler();
    startDriftScheduler();
    startAccessGrantSweeper();
  });

  injectWebSocket(server as unknown as Server);

  // Stop claiming new work, fail this instance's in-flight runbook runs so they do
  // not wait for the reaper, then close the listener and the DB pool.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received`);
    stopScheduler();
    stopBackup();
    stopAlertScheduler();
    stopAlertDispatcher();
    stopSslDailyScan();
    stopHeartbeatScheduler();
    stopPatchScheduler();
    stopDriftScheduler();
    stopAccessGrantSweeper();
    await stopRunbookBackground({ markOwnFailed: true }).catch((err) => console.error("[shutdown] runbooks:", err));
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
