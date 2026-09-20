/**
 * Adopt a pre-existing database into the migration history.
 *
 * Until 0.7 the Docker image ran `prisma db push`, which builds the schema
 * without recording anything in `_prisma_migrations`. Switching to
 * `migrate deploy` would therefore try to create tables that already exist and
 * abort on the first statement, so an upgrade would fail to start.
 *
 * This detects that case — application tables present, migration history empty
 * — and marks the baseline migration as already applied. It never modifies
 * application data, and it deliberately does nothing when the database is
 * genuinely empty (let `migrate deploy` create it) or already has history.
 *
 * Exit code is always 0: a failure here must not stop the container, because
 * `migrate deploy` runs next and will surface the real problem with a better
 * message.
 */
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const BASELINE = "20260921000000_baseline";

/** Inspect the database, then release the connection before shelling out. */
async function needsBaseline() {
  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('Server', '_prisma_migrations')",
    );
    const names = new Set(tables.map((t) => t.name));

    // Empty or brand-new database — let migrate deploy build it.
    if (!names.has("Server")) return false;

    if (names.has("_prisma_migrations")) {
      const applied = await prisma.$queryRawUnsafe(
        "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL",
      );
      if (Number(applied?.[0]?.n ?? 0) > 0) return false; // already tracked
    }
    return true;
  } finally {
    // SQLite is single-writer: `prisma migrate resolve` cannot take the lock
    // while this client still holds it, so disconnect before spawning it.
    await prisma.$disconnect();
  }
}

async function main() {
  if (!(await needsBaseline())) return;

  console.log(
    `[baseline] Existing schema found with no migration history. Reconciling it ` +
      `with the current schema, then recording ${BASELINE} as applied.`,
  );

  // Marking the baseline applied asserts the database already matches it. That
  // is not safe to assume: images before 0.7 used `db push`, so a database can
  // sit at whatever schema was current when it was last started and be missing
  // columns the baseline contains. Reconcile first.
  //
  // `db push` WITHOUT --accept-data-loss adds missing tables and columns and
  // aborts rather than dropping anything, which is exactly the guarantee we
  // want here. The old image passed --accept-data-loss; this deliberately does
  // not.
  execFileSync("node_modules/.bin/prisma", ["db", "push", "--skip-generate"], {
    stdio: "inherit",
  });

  execFileSync("node_modules/.bin/prisma", ["migrate", "resolve", "--applied", BASELINE], {
    stdio: "inherit",
  });
}

main().catch((err) => {
  console.warn("[baseline] check skipped:", err?.message ?? err);
});
