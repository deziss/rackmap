import { beforeAll, afterAll } from "vitest";

// Test env — must be set before any module imports
process.env["DATABASE_URL"] = "file:./test.db";
process.env["APP_ENCRYPTION_KEY"] = "dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleQ=="; // 32B base64
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

beforeAll(async () => {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");

  // Migrate test DB
  const { execSync } = await import("node:child_process");
  execSync("npx prisma migrate deploy --schema=./prisma/schema.prisma", {
    env: { ...process.env },
    stdio: "ignore",
  });

  // Seed test users
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
});

afterAll(async () => {
  await prisma.$disconnect();
});
