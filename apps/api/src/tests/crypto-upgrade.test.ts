import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../db.js";
import { updateServer } from "../modules/servers/server.service.js";
import { updateService } from "../modules/services/service.service.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import {
  initVault,
  lockVault,
  lockVaultGlobal,
  encryptPasswordWithVault,
  decryptPasswordWithVault,
} from "../services/vault.service.js";

/**
 * Same frozen legacy blob as vault.test.ts: AES-256-GCM under the raw APP_ENCRYPTION_KEY from
 * tests/setup.ts, in the original unsalted "v1.<iv>.<tag>.<ct>" shape. It stands in for a row
 * written before the scrypt envelope existed — exactly the rows the lazy upgrade is for.
 */
const LEGACY_V1_BLOB =
  "v1.5ae45e5617e83288a054a779.6034ead9a68d2da3ac16d291bdaeb9a0.8ba658596d1dcec9cc42738a43904f8dff9a2de0";
const LEGACY_V1_PLAINTEXT = "LegacyStoredPassword";

const HOSTNAME_PREFIX = "crypto-upgrade";
const SERVICE_PREFIX = "crypto-upgrade";

let seq = 0;

async function seedServer(passwordEnc: string | null): Promise<number> {
  seq++;
  const s = await prisma.server.create({
    data: {
      hostname: `${HOSTNAME_PREFIX}-${seq}.test`,
      ip: "203.0.113.10",
      username: "root",
      sshPort: 22,
      passwordEnc,
    },
    select: { id: true },
  });
  return s.id;
}

async function storedServerPassword(id: number): Promise<string | null> {
  const row = await prisma.server.findUnique({ where: { id }, select: { passwordEnc: true } });
  return row?.passwordEnc ?? null;
}

async function seedService(passwordEnc: string | null, authTokenEnc: string | null): Promise<number> {
  seq++;
  const s = await prisma.service.create({
    data: {
      serviceName: `${SERVICE_PREFIX}-${seq}`,
      passwordEnc,
      authTokenEnc,
    },
    select: { id: true },
  });
  return s.id;
}

async function storedServiceSecrets(id: number) {
  const row = await prisma.service.findUnique({
    where: { id },
    select: { passwordEnc: true, authTokenEnc: true },
  });
  return { passwordEnc: row?.passwordEnc ?? null, authTokenEnc: row?.authTokenEnc ?? null };
}

beforeAll(async () => {
  // These specs assert on the APP_ENCRYPTION_KEY envelope, which is only what gets written
  // while no vault session is unlocked. Make sure an earlier spec in this process did not
  // leave the deployment-wide session open.
  lockVaultGlobal();
});

afterAll(async () => {
  lockVaultGlobal();
  await prisma.server.deleteMany({ where: { hostname: { startsWith: HOSTNAME_PREFIX } } });
  await prisma.service.deleteMany({ where: { serviceName: { startsWith: SERVICE_PREFIX } } });
});

describe("lazy credential re-encryption on write (servers)", () => {
  it("upgrades a legacy v1 password to v3 on update, with the plaintext unchanged", async () => {
    const id = await seedServer(LEGACY_V1_BLOB);

    await updateServer(id, { remark: "unrelated edit" });

    const stored = await storedServerPassword(id);
    expect(stored).not.toBeNull();
    expect(stored).not.toBe(LEGACY_V1_BLOB);
    expect(stored!.startsWith("v3.")).toBe(true);
    // The whole point: the credential survives the envelope change byte-for-byte in plaintext.
    expect(decryptSecret(stored!)).toBe(LEGACY_V1_PLAINTEXT);
    await expect(decryptPasswordWithVault(stored!)).resolves.toBe(LEGACY_V1_PLAINTEXT);
  });

  it("leaves a password already on the current envelope byte-identical", async () => {
    const current = encryptSecret("AlreadyCurrentPassword");
    const id = await seedServer(current);

    await updateServer(id, { remark: "another unrelated edit" });

    // No pointless rewrite: same blob, same salt, same ciphertext.
    expect(await storedServerPassword(id)).toBe(current);
  });

  it("prefers a supplied new password over the upgrade of the old one", async () => {
    const id = await seedServer(LEGACY_V1_BLOB);

    await updateServer(id, { password: "BrandNewPassword1!", remark: "rotated" });

    const stored = await storedServerPassword(id);
    expect(stored!.startsWith("v3.")).toBe(true);
    expect(decryptSecret(stored!)).toBe("BrandNewPassword1!");
    // The re-encrypted legacy value must never have clobbered the new one.
    expect(decryptSecret(stored!)).not.toBe(LEGACY_V1_PLAINTEXT);
  });

  it("does not resurrect a password the same update explicitly clears", async () => {
    const id = await seedServer(LEGACY_V1_BLOB);

    await updateServer(id, { password: null });

    expect(await storedServerPassword(id)).toBeNull();
  });

  it("leaves a vault-wrapped v2 blob untouched and still decryptable", async () => {
    await prisma.systemVault.deleteMany();
    const token = "crypto-upgrade-vault-session";
    await initVault("CryptoUpgradePassphrase1!", token);
    try {
      const v2 = encryptPasswordWithVault("VaultWrappedSecret", token);
      expect(v2.startsWith("v2.")).toBe(true);

      const id = await seedServer(v2);
      // No session token on the write path — exactly the case where a naive upgrade would
      // hand a v2 blob to crypto.ts and destroy it.
      await updateServer(id, { remark: "touched while vault-wrapped" });

      const stored = await storedServerPassword(id);
      expect(stored).toBe(v2);
      await expect(decryptPasswordWithVault(stored!, token)).resolves.toBe("VaultWrappedSecret");
    } finally {
      lockVault(token);
      await prisma.systemVault.deleteMany();
    }
  });

  it("keeps a legacy blob that fails to decrypt rather than losing the credential", async () => {
    // Correct v1 shape, corrupted ciphertext: GCM will not authenticate it.
    const tampered = `${LEGACY_V1_BLOB.slice(0, -2)}00`;
    const id = await seedServer(tampered);

    await updateServer(id, { remark: "edit over an unreadable credential" });

    expect(await storedServerPassword(id)).toBe(tampered);
  });

  it("does not write a password column at all when there is nothing stored", async () => {
    const id = await seedServer(null);

    await updateServer(id, { remark: "no credential on this row" });

    expect(await storedServerPassword(id)).toBeNull();
  });
});

describe("lazy credential re-encryption on write (services)", () => {
  it("upgrades both passwordEnc and authTokenEnc on update", async () => {
    const id = await seedService(LEGACY_V1_BLOB, LEGACY_V1_BLOB);

    await updateService(id, { remark: "unrelated edit" });

    const { passwordEnc, authTokenEnc } = await storedServiceSecrets(id);
    expect(passwordEnc!.startsWith("v3.")).toBe(true);
    expect(authTokenEnc!.startsWith("v3.")).toBe(true);
    expect(decryptSecret(passwordEnc!)).toBe(LEGACY_V1_PLAINTEXT);
    expect(decryptSecret(authTokenEnc!)).toBe(LEGACY_V1_PLAINTEXT);
    // Two independent re-encryptions, so two independent salts.
    expect(passwordEnc).not.toBe(authTokenEnc);
  });

  it("leaves current envelopes byte-identical", async () => {
    const password = encryptSecret("ServicePassword");
    const token = encryptSecret("ServiceAuthToken");
    const id = await seedService(password, token);

    await updateService(id, { remark: "another unrelated edit" });

    expect(await storedServiceSecrets(id)).toEqual({ passwordEnc: password, authTokenEnc: token });
  });

  it("prefers a supplied new password while still upgrading the auth token", async () => {
    const id = await seedService(LEGACY_V1_BLOB, LEGACY_V1_BLOB);

    await updateService(id, { password: "NewServicePassword1!" });

    const { passwordEnc, authTokenEnc } = await storedServiceSecrets(id);
    expect(decryptSecret(passwordEnc!)).toBe("NewServicePassword1!");
    expect(authTokenEnc!.startsWith("v3.")).toBe(true);
    expect(decryptSecret(authTokenEnc!)).toBe(LEGACY_V1_PLAINTEXT);
  });

  it("leaves a vault-wrapped v2 blob in a service row untouched", async () => {
    await prisma.systemVault.deleteMany();
    const token = "crypto-upgrade-service-vault-session";
    await initVault("CryptoUpgradePassphrase2!", token);
    try {
      const v2 = encryptPasswordWithVault("ServiceVaultSecret", token);
      expect(v2.startsWith("v2.")).toBe(true);

      const id = await seedService(v2, v2);
      await updateService(id, { remark: "touched while vault-wrapped" });

      expect(await storedServiceSecrets(id)).toEqual({ passwordEnc: v2, authTokenEnc: v2 });
    } finally {
      lockVault(token);
      await prisma.systemVault.deleteMany();
    }
  });
});
