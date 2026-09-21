import { configDotenv } from "dotenv";
import { z } from "zod";

// Load .env with override so shell's empty exported vars don't shadow file values
configDotenv({ override: process.env.NODE_ENV !== "test" });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().default("file:./dev.db"),
  APP_ENCRYPTION_KEY: z.string().default(""),
  APP_ENCRYPTION_PASSPHRASE: z.string().optional(),
  VAULT_PASSPHRASE: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().default("http://localhost:5173"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  // Comma-separated allowed origins for CORS and Better Auth origin validation.
  // Left unset it resolves to WEB_ORIGIN (see below) — it must never silently mean
  // "any origin". "*" is still accepted as an explicit opt-in for internal deployments
  // on a trusted private network, and boots with a loud warning.
  TRUSTED_ORIGINS: z.string().optional(),
  // Trust X-Forwarded-For / X-Real-IP. Enable ONLY when RackMap sits behind a
  // reverse proxy you control that overwrites these headers. When false, the
  // headers are ignored: a client can otherwise forge its own audit-log IP and
  // mint an unlimited rate-limit bucket by rotating the value.
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // Comma-separated CIDRs of the proxies in front of RackMap, ordered any way.
  // Only consulted when TRUST_PROXY is on.
  //
  // This matters more than it looks: Better Auth resolves the client IP by
  // walking X-Forwarded-For from the right and returning the first address that
  // is NOT a known proxy. With no trusted proxies configured it refuses to
  // guess and returns null for any header carrying more than one value — and
  // the rate limiter then buckets every caller together under a single shared
  // key, which turns normal traffic into a fleet-wide 429.
  //
  // One hop (the bundled nginx) produces a single-value header and works
  // either way. Two or more hops (an ingress, a CDN, a corporate LB) need this.
  TRUSTED_PROXY_CIDRS: z.string().default(""),
  // Allow anyone who can reach the API to create their own account (role: viewer).
  // Off by default — an admin should be creating accounts instead.
  ALLOW_SELF_SIGNUP: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SCHEDULER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  PING_INTERVAL_MS: z.coerce.number().int().min(5000).default(60_000),
  PING_TIMEOUT_MS: z.coerce.number().int().min(200).default(3000),
  PING_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  STATUS_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  STATUS_FLIP_THRESHOLD: z.coerce.number().int().min(1).default(2),
  // How long a background job's database lease stays valid before another replica
  // may take it (services/job-lock.service.ts). The holder renews it every TTL/3
  // while the job is running, so in practice it only ever expires when that process
  // dies — which is the point: a replica killed mid-sweep must not hold the job
  // forever. Lower = faster failover to another replica, higher = more tolerance for
  // a holder that is merely slow. Must comfortably exceed one renewal round-trip.
  JOB_LOCK_TTL_MS: z.coerce.number().int().min(10_000).default(120_000),
  NOTIFY_WEBHOOK_URL: z.string().optional(),
  NOTIFY_TELEGRAM_BOT_TOKEN: z.string().optional(),
  NOTIFY_TELEGRAM_CHAT_ID: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("rackmap@example.com"),
  SERVE_STATIC_DIR: z.string().optional(),
  BACKUP_DIR: z.string().optional(),
  // M12 — live metrics (agentless SSH exec)
  METRICS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  METRICS_SSH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  // Background Metrics Alerting
  METRICS_ALERT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  METRICS_ALERT_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000), // 5 mins
  // Global thresholds
  ALERT_THRESHOLD_CPU: z.coerce.number().min(0).max(100).default(90),
  ALERT_THRESHOLD_RAM: z.coerce.number().min(0).max(100).default(95),
  ALERT_THRESHOLD_DISK: z.coerce.number().min(0).max(100).default(90),
  // M13 — gates ONLY the browser SSH terminal websocket (ws/ssh.ws.ts), off by default.
  // This is not a general remote-execution kill-switch: /os-users, /logs, /atop/*,
  // /auto-discover and /auto-update still run remote commands over SSH when it is false.
  SSH_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SSH_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  SSH_IDLE_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(300_000),
  SSH_MAX_SESSION_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  SSH_MAX_CONCURRENT: z.coerce.number().int().min(1).default(5),
  // How often a live SSH terminal WebSocket re-checks that the operator is STILL
  // allowed to hold it (session valid, not banned, role still grants server.ssh or
  // the approved AccessRequest has not expired). Authorization is otherwise only
  // evaluated once, at upgrade time.
  SSH_REAUTH_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  // Host-key verification policy for every outbound SSH connection
  // (see services/ssh-host-key.service.ts).
  //   "accept-any" — record + log, never refuse. First sightings are pinned and a
  //                  changed key logs a loud warning but the connection proceeds.
  //                  Rollout default so an existing fleet keeps working while the
  //                  host-key store is populated and reviewed.
  //   "tofu"       — trust on first use. First sighting is pinned and accepted; a
  //                  later mismatch aborts the handshake before authentication, so
  //                  no password is ever offered to the impostor.
  SSH_HOST_POLICY: z.enum(["accept-any", "tofu"]).default("accept-any"),
  // Absolute path to a private key tried first when opening SSH connections (optional).
  SSH_PRIVATE_KEY_PATH: z.string().optional(),
  // Licencia Licensing & Subscription
  LICENCIA_URL: z.string().optional(),
  LICENCIA_API_KEY: z.string().optional(),
  LICENCIA_PUBLIC_KEY: z.string().optional(),
  LICENCIA_LICENSE_KEY: z.string().optional(),
}).refine(
  (data) => {
    const raw = (data.APP_ENCRYPTION_PASSPHRASE || data.APP_ENCRYPTION_KEY || "").trim();
    return raw.length >= 8;
  },
  {
    message: "Either APP_ENCRYPTION_KEY or APP_ENCRYPTION_PASSPHRASE must be provided (at least 8 characters or 32-byte base64)",
    path: ["APP_ENCRYPTION_KEY"],
  }
);

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", z.treeifyError(parsed.error));
  process.exit(1);
}

// An unset TRUSTED_ORIGINS falls back to WEB_ORIGIN rather than "*", so a deployment that
// never configured CORS is locked to its own web origin instead of reflecting every caller.
const trustedOriginsRaw = (parsed.data.TRUSTED_ORIGINS ?? "").trim();
const resolvedTrustedOrigins = trustedOriginsRaw.length > 0 ? trustedOriginsRaw : parsed.data.WEB_ORIGIN;

if (resolvedTrustedOrigins === "*") {
  console.warn(
    '[security] TRUSTED_ORIGINS="*" is in effect: CORS reflects ANY origin back with ' +
      "credentials:true and Better Auth origin validation is disabled. Any site a signed-in " +
      "user visits can drive this API with their session cookie (CSRF), and the browser will " +
      "hand it the responses. Only acceptable on a trusted private network — set " +
      "TRUSTED_ORIGINS to an explicit comma-separated origin list for anything reachable " +
      "from an untrusted network.",
  );
}

export const env = { ...parsed.data, TRUSTED_ORIGINS: resolvedTrustedOrigins };
