/**
 * Adopt a pre-existing database into the migration history.
 *
 * Until 0.7 the Docker image ran `prisma db push`, which builds the schema
 * without recording anything in `_prisma_migrations`. Switching to
 * `migrate deploy` would therefore try to create tables that already exist and
 * abort on the first statement, so an upgrade would fail to start.
 *
 * This detects that case — application tables present, migration history empty
 * — and marks the migrations as already applied. It never modifies application
 * data, and it deliberately does nothing when the database is genuinely empty
 * (let `migrate deploy` create it) or already has history.
 *
 * Exit codes: 0 when there is nothing to do, when adoption succeeded, and when
 * the database does not exist yet (`migrate deploy`, which runs next, creates
 * it). Anything else — the detection query failing, or `db push` / `migrate
 * resolve` failing mid-adoption — is logged as an error and exits 1, which
 * stops the container's start chain instead of letting `migrate deploy` run
 * against a database in an unknown state. (The previous version swallowed
 * every error as "check skipped", which is how a broken detection query went
 * unnoticed.)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/** The first migration; the one a truncated 0.9-dev baseline left failed. */
const BASELINE = "20260921000000_postgres_baseline";

/**
 * Every migration directory, in lexical (chronological) order. `db push` below
 * brings the database to the CURRENT schema — i.e. the state after all of them
 * — so every one must be recorded, not just the first. Recording only the
 * baseline left later migrations pending, and they then failed trying to create
 * tables `db push` had already made, which aborted container start.
 */
function allMigrations() {
  const dir = path.join(process.cwd(), "prisma", "migrations");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "migration.sql")))
    .map((e) => e.name)
    .sort();
}

/** Resolved at call time so this works in both the repo and the container. */
function prismaCli() {
  return ["exec", "prisma"];
}

/** Prisma's "database does not exist" — expected on a first boot against a bare server. */
function isMissingDatabase(err) {
  return err?.errorCode === "P1003" || err?.code === "P1003";
}

/**
 * Inspect the database, then release the connection before shelling out.
 *
 * Table names are looked up in the connection's current schema (Prisma's
 * `?schema=` sets search_path), exactly as Prisma itself will address them.
 * "Server" is an unmapped model, so its table name is case-sensitive.
 */
async function needsBaseline() {
  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRaw`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('Server', '_prisma_migrations')`;
    const names = new Set(tables.map((t) => t.name));

    if (!names.has("Server")) {
      // Empty or brand-new database — let migrate deploy build it. The one
      // exception worth a pointer: a history holding only a FAILED baseline,
      // left by the truncated baseline shipped in a 0.9 development build.
      // Postgres rejected that script before running any of it, so nothing was
      // created; migrate deploy refuses to continue until it is resolved.
      if (names.has("_prisma_migrations")) {
        const failed = await prisma.$queryRaw`
          SELECT migration_name FROM _prisma_migrations
          WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
        if (failed.some((m) => m.migration_name === BASELINE)) {
          console.error(
            `[baseline] Migration ${BASELINE} is recorded as FAILED and no application ` +
              "tables exist, so nothing was applied. Mark it rolled back, then start again:\n" +
              `  pnpm exec prisma migrate resolve --rolled-back ${BASELINE}\n` +
              "(Docker: docker compose run --rm api pnpm exec prisma migrate resolve " +
              `--rolled-back ${BASELINE}). See MIGRATION.md.`,
          );
        }
      }
      return false;
    }

    if (names.has("_prisma_migrations")) {
      const applied = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      if (Number(applied?.[0]?.n ?? 0) > 0) return false; // already tracked
    }
    return true;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  let needed;
  try {
    needed = await needsBaseline();
  } catch (err) {
    if (isMissingDatabase(err)) {
      console.log("[baseline] Database does not exist yet; migrate deploy will create it.");
      return;
    }
    throw new Error(`could not inspect the database: ${err?.message ?? err}`);
  }
  if (!needed) return;

  console.log(
    "[baseline] Existing schema found with no migration history. Reconciling it " +
      "with the current schema, then recording the migration history as applied.",
  );

  // Marking the migrations applied asserts the database already matches them.
  // That is not safe to assume: images before 0.7 used `db push`, so a database
  // can sit at whatever schema was current when it was last started and be
  // missing columns the migrations contain. Reconcile first.
  //
  // `db push` WITHOUT --accept-data-loss adds missing tables and columns and
  // aborts rather than dropping anything, which is exactly the guarantee we
  // want here. The old image passed --accept-data-loss; this deliberately does
  // not.
  execFileSync("pnpm", [...prismaCli(), "db", "push", "--skip-generate"], {
    stdio: "inherit",
  });

  // `resolve --applied` also accepts a migration recorded as failed, which is
  // what a `db push`-built database that then hit the truncated baseline has.
  for (const migration of allMigrations()) {
    execFileSync("pnpm", [...prismaCli(), "migrate", "resolve", "--applied", migration], {
      stdio: "inherit",
    });
  }
}

main().catch((err) => {
  console.error(
    "[baseline] FAILED — not starting, so migrate deploy does not run against a " +
      `database in an unknown state: ${err?.message ?? err}`,
  );
  process.exitCode = 1;
});
