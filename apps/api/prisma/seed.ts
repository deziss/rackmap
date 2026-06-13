// Load env before any other imports
const envPath = new URL("../.env", import.meta.url).pathname;
const { config } = await import("dotenv");
config({ path: envPath });

import { generateId } from "better-auth";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/lib/crypto.js";

// Use better-auth's own scrypt hasher via resolved path (not in exports map).
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
// resolve() → .../better-auth/dist/index.cjs — strip filename only, keep /dist/
const baDir = _require.resolve("better-auth").replace(/\/[^/]+$/, "");
const { hashPassword } = await import(
  /* @vite-ignore */
  `file://${baDir}/crypto/password.mjs`
) as { hashPassword: (pw: string) => Promise<string> };

async function main() {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");

  const email = process.env["SEED_ADMIN_EMAIL"] ?? "admin@inventory.local";
  const password = process.env["SEED_ADMIN_PASSWORD"] ?? "Admin123!";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const userId = generateId();
    const accountId = generateId();
    const now = new Date();
    const hashedPw = await hashPassword(password);

    await prisma.$transaction([
      prisma.user.create({
        data: { id: userId, name: "Admin", email, emailVerified: true, role: "admin", createdAt: now, updatedAt: now },
      }),
      prisma.account.create({
        data: {
          id: accountId,
          userId,
          accountId: email,
          providerId: "credential",
          password: hashedPw,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ]);
    console.log("Created admin user:", email);
  } else {
    await prisma.user.updateMany({ where: { email }, data: { role: "admin" } });
    console.log("Admin user already exists:", email);
  }

  // Seed test users for editor and viewer roles
  const testUsers: Array<{ email: string; name: string; role: string; password: string }> = [
    { email: "editor@inventory.local", name: "Editor", role: "editor", password: "Editor123!" },
    { email: "viewer@inventory.local", name: "Viewer", role: "viewer", password: "Viewer123!" },
  ];
  for (const u of testUsers) {
    const ex = await prisma.user.findUnique({ where: { email: u.email } });
    if (!ex) {
      const uid = generateId();
      const now = new Date();
      const hpw = await hashPassword(u.password);
      await prisma.$transaction([
        prisma.user.create({ data: { id: uid, name: u.name, email: u.email, emailVerified: true, role: u.role, createdAt: now, updatedAt: now } }),
        prisma.account.create({ data: { id: generateId(), userId: uid, accountId: u.email, providerId: "credential", password: hpw, createdAt: now, updatedAt: now } }),
      ]);
      console.log(`Created ${u.role} user:`, u.email);
    } else {
      await prisma.user.updateMany({ where: { email: u.email }, data: { role: u.role } });
    }
  }

  // Seed lookup tables
  for (const name of ["AWS", "GCP", "Azure"])
    await prisma.cloudProvider.upsert({ where: { name }, create: { name }, update: {} });

  for (const name of ["NVIDIA A100", "NVIDIA H100", "AMD MI300X", "NVIDIA RTX 4090"])
    await prisma.gpuType.upsert({ where: { name }, create: { name }, update: {} });

  for (const name of ["ML Team", "DevOps", "Research", "QA"])
    await prisma.allocatedTo.upsert({ where: { name }, create: { name }, update: {} });

  for (const name of ["DC1-Rack-A", "DC1-Rack-B", "DC2-Rack-A", "Cloud-US-East"])
    await prisma.location.upsert({ where: { name }, create: { name }, update: {} });

  for (const name of ["GPU Server", "CPU Server", "Storage Server", "Edge Node"])
    await prisma.serverType.upsert({ where: { name }, create: { name }, update: {} });

  const cloudProvider = await prisma.cloudProvider.findFirst({ where: { name: "AWS" } });
  const gpuType = await prisma.gpuType.findFirst({ where: { name: "NVIDIA A100" } });
  const location = await prisma.location.findFirst({ where: { name: "DC1-Rack-A" } });

  const sampleServers = [
    { hostname: "gpu01.nuvo.ai", ip: "192.168.1.101", username: "root",   password: "sample-pass-1", sshPort: 22,   cpu: "AMD EPYC 7742",       ram: "512GB", gpuCount: 8, remark: "Primary GPU cluster node", domain: "nuvo.ai", environment: "on-premise", cloudProviderId: null },
    { hostname: "gpu02.nuvo.ai", ip: "192.168.1.102", username: "ubuntu", password: "sample-pass-2", sshPort: 2222, cpu: "Intel Xeon Gold 6248", ram: "256GB", gpuCount: 4, remark: "Secondary node — SSH port 2222", domain: "nuvo.ai", environment: "cloud", cloudProviderId: cloudProvider?.id },
  ];

  for (const { password: p, ...rest } of sampleServers) {
    const exists = await prisma.server.findFirst({ where: { hostname: rest.hostname } });
    if (!exists) {
      await prisma.server.create({
        data: { ...rest, passwordEnc: encryptSecret(p), gpuTypeId: gpuType?.id, locationId: location?.id },
      });
    }
  }

  console.log("Seed complete");
}

main().catch(console.error).finally(() => prisma.$disconnect());
