import { beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";

// Test env — must be set before any module imports
process.env["DATABASE_URL"] = "file:./test.db";
process.env["APP_ENCRYPTION_KEY"] = "dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q="; // 32B base64
process.env["BETTER_AUTH_SECRET"] = "test-secret-for-vitest-only-min16";
process.env["BETTER_AUTH_URL"] = "http://localhost:5173";
process.env["WEB_ORIGIN"] = "http://localhost:5173";
process.env["SCHEDULER_ENABLED"] = "false";
process.env["NODE_ENV"] = "test";

import { createRequire } from "node:module";
const _req = createRequire(import.meta.url);
const baDir = _req.resolve("better-auth").replace(/\/[^/]+$/, "");
const { hashPassword } = await import(`file://${baDir}/crypto/password.mjs`) as {
  hashPassword: (pw: string) => Promise<string>;
};

import { generateId } from "better-auth";

// Lazy import after env is set
const { prisma } = await import("../db.js");

/**
 * The test database is a real SQLite file reused by every spec. Left alone it
 * accumulates rows across runs, which makes results order-dependent: a test can
 * pass because a previous run left the right state behind, and fail on a clean
 * checkout. Reset it exactly once per process, before any Prisma connection is
 * opened, then let each file seed what it needs.
 *
 * `setupFiles` runs once per test file, so the guard is a process-global rather
 * than a module-local — under `pool: forks, singleFork` all files share one
 * process and must not each wipe the database out from under the others.
 */
const RESET_FLAG = Symbol.for("rackmap.test.db.reset");
const globalStore = globalThis as unknown as Record<symbol, boolean>;

function resetTestDatabaseOnce(): boolean {
  if (globalStore[RESET_FLAG]) return false;
  globalStore[RESET_FLAG] = true;

  const apiDir = new URL("../..", import.meta.url).pathname;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const file = `${apiDir}/prisma/test.db${suffix}`;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // a locked file from a crashed run is not fatal; db push will recreate
    }
  }
  return true;
}

beforeAll(async () => {
  const isFirstFile = resetTestDatabaseOnce();

  // Migrate test DB before opening prisma connections
  const { execSync } = await import("node:child_process");
  const apiDir = new URL("../..", import.meta.url).pathname;
  if (!isFirstFile) {
    // Schema is already in place for this process; skip the ~1s db push.
    await seedTestUsers();
    return;
  }
  try {
    execSync("pnpm exec prisma db push --skip-generate --schema=./prisma/schema.prisma", {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: "file:./test.db" },
      stdio: "pipe",
    });
  } catch (err: any) {
    console.error("Migration deploy in test setup failed:", err.stdout?.toString(), err.stderr?.toString());
    throw err;
  }

  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await seedTestUsers();
});

/** Idempotently ensure the three fixture accounts exist with the right roles. */
async function seedTestUsers() {
  const users = [
    { email: "admin@inventory.local",  name: "Admin",  role: "admin",  pw: "Admin123!" },
    { email: "editor@inventory.local", name: "Editor", role: "editor", pw: "Editor123!" },
    { email: "viewer@inventory.local", name: "Viewer", role: "viewer", pw: "Viewer123!" },
  ];

  for (const u of users) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (!existing) {
      const uid = generateId();
      const now = new Date();
      const hpw = await hashPassword(u.pw);
      await prisma.$transaction([
        prisma.user.create({ data: { id: uid, name: u.name, email: u.email, emailVerified: true, role: u.role, createdAt: now, updatedAt: now } }),
        prisma.account.create({ data: { id: generateId(), userId: uid, accountId: u.email, providerId: "credential", password: hpw, createdAt: now, updatedAt: now } }),
      ]);
    } else {
      await prisma.user.updateMany({ where: { email: u.email }, data: { role: u.role } });
    }
  }
}

afterAll(async () => {
  await prisma.$disconnect();
});
