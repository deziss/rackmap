/**
 * Startup preflight — runs before migrations, the seed and the app itself.
 *
 * The container start chain is
 *
 *   preflight → ensure-baseline → migrate deploy → seed → app
 *
 * and every step after this one reports failures in its own vocabulary. A
 * missing DATABASE_URL used to surface as `[baseline] FAILED — … a database in
 * an unknown state`, which reads as a migration problem and sends the operator
 * to MIGRATION.md; the real fault was a bad .env. An unreachable database
 * surfaced as a Prisma stack trace. This runs first and says, in one message,
 * which variable is wrong and what to do about it.
 *
 * Deliberately sequential: it stops at the first failing group. Someone whose
 * database is unreachable does not also need to hear about their admin
 * password — they will see that on the next attempt, once this one passes.
 *
 * Built to dist/preflight.js (tsup.config.ts) and prepended to the Dockerfile
 * CMD. Bare-metal: `pnpm --filter @inv/api preflight`.
 */

import { PrismaClient } from "@prisma/client";

// ── Group 1: schema ──────────────────────────────────────────────────────────
// This import IS the check. ./env.js loads .env exactly as the app does —
// configDotenv({ override: true }), so the file beats exported shell vars —
// then parses process.env with EnvSchema and, on failure, prints
// formatEnvProblems() and exits 1 before anything below runs. Reading
// process.env raw here instead would report a different reality than the one
// the app actually boots into.
import { env } from "./env.js";
import {
  closingLine,
  databaseUrlProblem,
  formatEnvProblems,
  formatStartupError,
  redactDatabaseUrl,
  type StartupProblem,
} from "./lib/env-errors.js";
import { isWeakAdminPassword, MIN_ADMIN_PASSWORD_LENGTH } from "./lib/admin-password.js";

const IN_DOCKER = process.env["IN_DOCKER"] === "true";

function die(title: string, problems: StartupProblem[], closing?: string): never {
  console.error("");
  console.error(formatStartupError(title, problems, closing));
  console.error("");
  process.exit(1);
}

/** Hostname the connection string points at, lowercased; "" when unparseable. */
function databaseHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Bound the connect attempt. Without this a wrong host hangs on the OS TCP
 * timeout — well over a minute — and the container looks stuck rather than
 * misconfigured.
 */
function withConnectTimeout(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "5");
    return url.toString();
  } catch {
    return raw;
  }
}

function prismaErrorCode(err: unknown): string | undefined {
  const e = err as { errorCode?: unknown; code?: unknown } | null;
  const code = e?.errorCode ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Group 2: DATABASE_URL shape ──────────────────────────────────────────────
// EnvSchema already refuses a malformed URL, so in practice group 1 catches
// this. Repeating it costs nothing and keeps preflight meaningful on its own:
// it is the check that must not be skipped if the schema's default ever
// changes, and it produces the same block either way — the renderer is fed a
// single synthetic issue so the DATABASE_URL hint (percent-encoding, and why
// this almost always means DOCKER_DATABASE_URL was hand-written) is worded in
// exactly one place.
function checkDatabaseUrlShape(): void {
  const problem = databaseUrlProblem(env.DATABASE_URL);
  if (!problem) return;
  console.error("");
  console.error(
    formatEnvProblems(
      { issues: [{ path: ["DATABASE_URL"], message: problem }] },
      { inDocker: IN_DOCKER, values: { DATABASE_URL: env.DATABASE_URL } },
    ),
  );
  console.error("");
  process.exit(1);
}

/** Non-fatal observations. Printed once, before anything can abort the run. */
function emitWarnings(): void {
  if (IN_DOCKER && env.NODE_ENV !== "production") {
    console.warn(
      `[preflight] warning: NODE_ENV=${env.NODE_ENV} inside Docker. The seed will create the ` +
        "demo accounts (editor@/viewer@inventory.local) and sample servers, whose passwords are " +
        "published in this repository. Set NODE_ENV=production in .env for any instance someone " +
        "else can reach.",
    );
  }
  if (!isBrowserOrigin(env.WEB_ORIGIN)) {
    console.warn(
      `[preflight] warning: WEB_ORIGIN is not a URL (${JSON.stringify(env.WEB_ORIGIN)}). It is the ` +
        "CORS fallback when TRUSTED_ORIGINS is unset, so the browser will be refused. Expected " +
        "something like http://localhost:8080.",
    );
  }
}

/**
 * An origin a browser can actually send. `new URL()` alone is not enough:
 * "localhost:8080" parses happily as protocol "localhost:" with path "8080",
 * which is precisely the mistake this warning exists to catch.
 */
function isBrowserOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** How the database answered the connection attempt. */
type DatabaseState = "reachable" | "missing";

// ── Group 3: connectivity ────────────────────────────────────────────────────
async function checkConnectivity(prisma: PrismaClient): Promise<DatabaseState> {
  try {
    // $connect() first, and not only for tidiness: it is the call that carries
    // the diagnosis. When the first thing a client does is $queryRaw, the
    // failure still arrives as a PrismaClientInitializationError but with
    // errorCode undefined — every case below would collapse into the generic
    // branch. $connect() sets P1000/P1001/P1003; SELECT 1 then proves the
    // connection is actually usable and not merely open.
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    return "reachable";
  } catch (err) {
    const code = prismaErrorCode(err);
    const target: StartupProblem["name"] = "DATABASE_URL";
    const status = redactDatabaseUrl(env.DATABASE_URL);
    const host = databaseHost(env.DATABASE_URL);

    if (code === "P1003") {
      // Not fatal, and deliberately so: `migrate deploy` creates the database a
      // moment later. ensure-baseline.mjs treats P1003 the same way.
      console.log("[preflight] Database does not exist yet; migrate deploy will create it.");
      return "missing";
    }

    if (code === "P1001") {
      if (IN_DOCKER && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
        // Nothing in the compose stack ever points the API at its own
        // loopback, so this is the built-in development default showing
        // through: the container received no DATABASE_URL at all. That is an
        // upgrade hazard rather than a typo — compose no longer sets
        // DATABASE_URL (it cannot percent-encode the password), the entrypoint
        // builds it from POSTGRES_*, and an image built before that change has
        // no entrypoint which does so.
        die(
          "the database is not reachable:",
          [
            {
              name: target,
              status,
              summary:
                "This container is trying to reach a database on its own localhost, which means " +
                "it was started without a DATABASE_URL and fell back to the built-in development " +
                "default. Your api image predates this compose file: compose no longer sets " +
                "DATABASE_URL — apps/api/entrypoint.sh assembles it from POSTGRES_* with the " +
                "password percent-encoded — and an image built before that change has no " +
                "entrypoint doing it.",
              lines: ["Rebuild the image:  docker compose up -d --build   (or: make up)"],
            },
          ],
        );
      }

      if (host === "postgres") {
        die("the database is not reachable:", [
          {
            name: target,
            status,
            summary:
              "The bundled database container is not accepting connections. It is either still " +
              "starting up (the first boot initialises its data directory, which takes a while) " +
              "or it is unhealthy.",
            lines: ["Look at it:  make logs", "Or:          docker compose ps"],
          },
        ]);
      }

      die("the database is not reachable:", [
        {
          name: target,
          status,
          summary:
            `Nothing answered at ${host || "the configured host"}. Check that the host and port in ` +
            "DATABASE_URL are right, that PostgreSQL is running there, and that a firewall is not " +
            "in the way.",
        },
      ], closingLine(IN_DOCKER));
    }

    if (code === "P1000") {
      die("the database rejected the credentials:", [
        {
          name: target,
          status,
          summary:
            "Authentication failed for the user in DATABASE_URL. If you changed POSTGRES_PASSWORD " +
            "in .env after the stack had already started once, that is the cause: the postgres " +
            "image only reads POSTGRES_PASSWORD when it initialises an EMPTY data directory, so " +
            "the database still wants the old password no matter what .env now says.",
          lines: [
            "Put the original POSTGRES_PASSWORD back in .env, or:",
            "  make reset   (deletes the database volume and everything in it)",
          ],
        },
      ]);
    }

    die("the database could not be queried:", [
      {
        name: target,
        status,
        summary: `${code ? `${code}: ` : ""}${errorMessage(err)}`,
      },
    ]);
  }
}

// ── Group 4: the first administrator ─────────────────────────────────────────
/**
 * True only when the seed will actually create the initial admin: no User
 * table yet, or one with no rows. An installation that already has users is
 * none of preflight's business — seed.ts bails out there anyway, and nagging a
 * running instance about SEED_ADMIN_PASSWORD on every restart trains operators
 * to ignore this output.
 */
async function databaseIsFresh(prisma: PrismaClient): Promise<boolean> {
  // "user", not "User": the Prisma model is User but it carries @@map("user")
  // (better-auth's table naming), and to_regclass takes the PHYSICAL name. It
  // stays double-quoted because `user` is a reserved word in PostgreSQL — an
  // unquoted one resolves to the CURRENT_USER function, not the table.
  // ensure-baseline.mjs probes "Server" instead, which is an unmapped model and
  // genuinely capitalised; the two are not interchangeable.
  const present = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('"user"') IS NOT NULL AS present`;
  if (present[0]?.present !== true) return true;

  // The count goes through the client so the mapping is applied by Prisma
  // rather than restated here.
  return (await prisma.user.count()) === 0;
}

function checkAdminPassword(): void {
  const raw = process.env["SEED_ADMIN_PASSWORD"] ?? "";
  if (!isWeakAdminPassword(raw)) return;

  if (env.NODE_ENV === "production") {
    die("the first administrator account cannot be created:", [
      {
        name: "SEED_ADMIN_PASSWORD",
        // docker-compose passes ${SEED_ADMIN_PASSWORD:-}, so "never set" and
        // "set to nothing" arrive here identically — say "missing" for both.
        status: raw.trim() === "" ? "missing" : "(set, but too weak)",
        summary:
          "This database is empty, so the next step creates the first administrator account. In " +
          "production it may not be created with a blank, default or published password — that " +
          `is an open door on anything reachable. Use ${MIN_ADMIN_PASSWORD_LENGTH}+ characters ` +
          "that are not one of the examples in the README.",
        lines: ["Generate one:  openssl rand -base64 18"],
      },
    ]);
  }

  console.warn(
    "[preflight] warning: SEED_ADMIN_PASSWORD is unset or weak and this database is empty. " +
      "NODE_ENV is not production, so the first admin will be created with the development " +
      "password documented in the README. Set SEED_ADMIN_PASSWORD before anyone else can reach " +
      "this instance.",
  );
}

async function main(): Promise<void> {
  // Group 1 already ran, at the import of ./env.js.
  emitWarnings();
  checkDatabaseUrlShape();

  const prisma = new PrismaClient({ datasourceUrl: withConnectTimeout(env.DATABASE_URL) });
  let state: DatabaseState;
  try {
    state = await checkConnectivity(prisma);
    // No database yet means no users yet, so the admin policy still applies —
    // it just cannot be confirmed by a query.
    if (state === "missing" || (await databaseIsFresh(prisma))) checkAdminPassword();
  } finally {
    await prisma.$disconnect();
  }

  const where = redactDatabaseUrl(env.DATABASE_URL);
  console.log(
    state === "missing"
      ? `[preflight] ok — environment valid, database server reachable (${where}).`
      : `[preflight] ok — environment valid, database reachable (${where}).`,
  );
}

await main().catch((err: unknown) => {
  // Anything that reached here is a bug in preflight itself, not a
  // misconfiguration — every expected failure exits through die(). Say so
  // rather than letting it look like another cryptic startup error.
  console.error(`[preflight] unexpected failure: ${errorMessage(err)}`);
  process.exit(1);
});
