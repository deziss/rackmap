import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import { env } from "../env.js";
import { withJobLock } from "./job-lock.service.js";

const LOCK_NAME = "backup:nightly";

/**
 * The nightly backup gets its own lease, and a long, fixed one rather than
 * JOB_LOCK_TTL_MS.
 *
 * Every replica's schedule fires at the same wall-clock minute and a small
 * database dumps in seconds, so a lease released the moment the dump finished
 * would simply be picked up by the replica whose clock is a second behind,
 * which would then back the same database up again. This lease is therefore
 * held until it expires (`holdUntilExpiry`) instead of being released: ten
 * minutes comfortably covers NTP-level skew between replicas. (A BACKUP_CRON
 * that fires more often than every ten minutes will skip runs because of it.)
 */
const BACKUP_LOCK_TTL_MS = 10 * 60 * 1000;

/** A dump that has not finished in this long is killed and reported as failed. */
const PG_DUMP_TIMEOUT_MS = 30 * 60 * 1000;

/** `rackmap-2026-09-25T02-00-00-000Z.dump`: lexical order is chronological order. */
const DUMP_NAME = /^rackmap-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.dump$/;

export type BackupHealth = {
  /** BACKUP_DIR is set, so a schedule is (or should be) running. */
  enabled: boolean;
  /** Result of the startup `pg_dump --version` probe. */
  pgDump: "ok" | "missing" | "unknown";
  pgDumpVersion: string | null;
  schedule: string | null;
  /** Set when BACKUP_CRON could not be parsed; no backups run. */
  scheduleError: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFile: string | null;
  lastError: string | null;
};

const health: BackupHealth = {
  enabled: false,
  pgDump: "unknown",
  pgDumpVersion: null,
  schedule: null,
  scheduleError: null,
  nextRunAt: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastFile: null,
  lastError: null,
};

let job: Cron | null = null;

/** Snapshot of the backup subsystem for /health/ready and diagnostics. */
export function getBackupHealth(): BackupHealth {
  return { ...health, nextRunAt: job?.nextRun()?.toISOString() ?? health.nextRunAt };
}

type ExecResult = { stdout: string; stderr: string };

/** execFile as a promise. Never a shell: argv goes to the binary as-is. */
function run(
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stderr: String(stderr ?? "") });
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

type PgConnection = {
  /** Variables for the child environment — the only place the password goes. */
  env: Record<string, string>;
  /** `?schema=` from the Prisma URL, dumped with --schema. */
  schema: string | null;
};

/**
 * Split a Prisma DATABASE_URL into libpq environment variables.
 *
 * The URL is not handed to pg_dump as `--dbname`: that would put the password
 * in argv, where every local user can read it from `ps` / /proc for as long as
 * the dump runs. libpq would also reject Prisma-only parameters such as
 * `schema` and `connection_limit` as invalid URI options.
 */
export function pgConnectionFromUrl(databaseUrl: string): PgConnection {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`DATABASE_URL must be a postgresql:// URL (got ${url.protocol})`);
  }

  const out: Record<string, string> = {};
  const q = url.searchParams;
  // `?host=/run/postgresql` is how a Unix-socket connection is spelled.
  const host = q.get("host") || decodeURIComponent(url.hostname);
  if (host) out.PGHOST = host.replace(/^\[(.*)\]$/, "$1"); // IPv6 literal without brackets
  out.PGPORT = url.port || "5432";
  if (url.username) out.PGUSER = decodeURIComponent(url.username);
  if (url.password) out.PGPASSWORD = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database) out.PGDATABASE = database;
  const sslmode = q.get("sslmode");
  if (sslmode) out.PGSSLMODE = sslmode;
  for (const [param, name] of [
    ["sslcert", "PGSSLCERT"],
    ["sslkey", "PGSSLKEY"],
    ["sslrootcert", "PGSSLROOTCERT"],
  ] as const) {
    const v = q.get(param);
    if (v) out[name] = v;
  }

  return { env: out, schema: q.get("schema") || null };
}

/**
 * Environment for the pg_dump child: PATH plus the libpq variables, and
 * nothing else. The API's own environment carries BETTER_AUTH_SECRET,
 * APP_ENCRYPTION_KEY and VAULT_PASSPHRASE, none of which pg_dump needs, and any
 * PG* variable already exported there would silently override the URL.
 */
function childEnv(conn: PgConnection): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    PGAPPNAME: "rackmap-backup",
    PGCONNECT_TIMEOUT: "30",
    ...conn.env,
  };
}

/** Delete all but the `keep` newest rackmap dumps in `dir`. Other files are never touched. */
export async function rotateBackups(dir: string, keep: number): Promise<string[]> {
  const dumps = (await readdir(dir)).filter((f) => DUMP_NAME.test(f)).sort().reverse();
  const removed: string[] = [];
  for (const name of dumps.slice(Math.max(1, keep))) {
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch (err) {
      console.error(`[backup] could not remove old backup ${name}:`, (err as Error).message);
    }
  }
  return removed;
}

/**
 * Dump the database to BACKUP_DIR in pg_dump custom format (restore with
 * pg_restore), then rotate to the BACKUP_KEEP newest dumps. No-op when
 * BACKUP_DIR is unset.
 *
 * The dump is written to a dot-prefixed partial file and renamed into place
 * only on success, so a killed or failed dump never counts as a backup and
 * never causes a good one to be rotated out.
 *
 * Unlocked on purpose: an operator asking for a backup on demand should get one.
 */
export async function runBackup(): Promise<{ ok: boolean; file?: string; error?: string }> {
  if (!env.BACKUP_DIR) return { ok: false, error: "BACKUP_DIR is not set" };
  const dir = env.BACKUP_DIR;
  const started = new Date();
  health.lastRunAt = started.toISOString();

  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const name = `rackmap-${stamp}.dump`;
  const final = join(dir, name);
  const partial = join(dir, `.${name}.partial`);

  try {
    const conn = pgConnectionFromUrl(env.DATABASE_URL);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const args = ["--format=custom", "--no-password", `--file=${partial}`];
    // --schema takes a pattern that is case-folded and treats * ? . specially;
    // double-quoting makes it an exact match on the name Prisma uses.
    if (conn.schema) args.push(`--schema="${conn.schema.replace(/"/g, '""')}"`);

    await run("pg_dump", args, { env: childEnv(conn), timeout: PG_DUMP_TIMEOUT_MS });

    // The dump holds password hashes and every encrypted credential.
    await chmod(partial, 0o600);
    await rename(partial, final);

    health.pgDump = "ok";
    health.lastSuccessAt = new Date().toISOString();
    health.lastFile = name;
    health.lastError = null;
    const removed = await rotateBackups(dir, env.BACKUP_KEEP);
    console.log(
      `[backup] ${final}` + (removed.length ? ` (rotated out ${removed.length} old backup(s))` : ""),
    );
    return { ok: true, file: final };
  } catch (err) {
    await unlink(partial).catch(() => {});
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    let message: string;
    if (e.code === "ENOENT" && e.path === "pg_dump") {
      health.pgDump = "missing";
      message = "pg_dump not found on PATH (install the PostgreSQL client matching the server version)";
    } else if (e.killed) {
      message = `pg_dump timed out after ${PG_DUMP_TIMEOUT_MS / 60_000} minutes`;
    } else {
      // pg_dump's stderr names the failing object or connection problem; it
      // never contains the password, which only ever travelled in the env.
      message = (e.stderr?.trim() || e.message).slice(0, 1000);
    }
    health.lastError = message;
    console.error(`[backup] FAILED: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * The scheduled backup: `runBackup()` behind the cross-replica lease, so exactly
 * one instance dumps the database per scheduled run.
 */
async function runScheduledBackup(): Promise<void> {
  try {
    await withJobLock(LOCK_NAME, BACKUP_LOCK_TTL_MS, async () => runBackup(), { holdUntilExpiry: true });
  } catch (err) {
    // Lease failure only (runBackup handles its own errors). Never let it
    // escape into croner, or the schedule would report the job as crashed.
    console.error("[backup] lock error:", (err as Error).message);
  }
}

/** Startup probe: is pg_dump installed, and which version? */
async function probePgDump(): Promise<void> {
  try {
    const { stdout } = await run("pg_dump", ["--version"], {
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      timeout: 10_000,
    });
    health.pgDump = "ok";
    health.pgDumpVersion = stdout.trim();
    console.log(`[backup] using ${health.pgDumpVersion}`);
  } catch (err) {
    health.pgDump = "missing";
    console.error(
      "[backup] pg_dump is NOT available — scheduled backups will fail until a PostgreSQL " +
        "client matching the server's major version is installed (the Docker image ships " +
        `postgresql18-client). Cause: ${(err as Error).message}`,
    );
  }
}

/**
 * Schedule backups on BACKUP_CRON (5-field cron, evaluated in the process's
 * local time zone — UTC in the Docker image unless TZ is set). Only runs if
 * BACKUP_DIR is set. The name is kept for index.ts.
 */
export function scheduleBackup(): void {
  if (!env.BACKUP_DIR || job) return;
  health.enabled = true;
  health.schedule = env.BACKUP_CRON;
  void probePgDump();

  try {
    job = new Cron(
      env.BACKUP_CRON,
      // Vixie semantics: a restricted day-of-month OR day-of-week matches, as in crontab(5).
      { mode: "5-part", domAndDow: false, protect: true, unref: true },
      () => runScheduledBackup(),
    );
  } catch (err) {
    health.scheduleError = (err as Error).message;
    console.error(
      `[backup] invalid BACKUP_CRON "${env.BACKUP_CRON}" — backups are DISABLED: ${(err as Error).message}`,
    );
    return;
  }
  const next = job.nextRun();
  health.nextRunAt = next?.toISOString() ?? null;
  console.log(`[backup] scheduled "${env.BACKUP_CRON}" — next run ${health.nextRunAt ?? "never"}`);
}

/** Stop the backup schedule (graceful shutdown). An in-flight dump is left to finish. */
export function stopBackup(): void {
  job?.stop();
  job = null;
}
