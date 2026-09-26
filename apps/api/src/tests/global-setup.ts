import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/**
 * Runs once per `vitest run`, before any spec file: bring the test database's
 * schema up to date, then empty every table so results never depend on rows a
 * previous run left behind. Spec files run one at a time in their own forks
 * (see vitest.config.ts) and only seed the fixture accounts (setup.ts).
 */
export default async function globalSetup() {
  const url =
    process.env["TEST_DATABASE_URL"] || "postgresql://postgres:postgres@localhost:5432/server_inventory_test?schema=public";
  // The reset below is destructive. Refuse anything that is not obviously a
  // throwaway test database, so a stray TEST_DATABASE_URL can never wipe real data.
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/_test$/.test(dbName)) {
    throw new Error(
      `Refusing to run tests against database "${dbName}": the test suite resets its database, ` +
        `so TEST_DATABASE_URL must name a database ending in "_test".`,
    );
  }

  const apiDir = new URL("../..", import.meta.url).pathname;
  try {
    execSync("pnpm exec prisma db push --skip-generate --schema=./prisma/schema.prisma", {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
  } catch (err: any) {
    console.error("Test database schema sync failed:", err.stdout?.toString(), err.stderr?.toString());
    throw err;
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
    if (tables.length > 0) {
      const list = tables.map((t) => `"${t.tablename.replace(/"/g, '""')}"`).join(", ");
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
