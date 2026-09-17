import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../db.js";
import {
  initVault,
  unlockVault,
  lockVault,
  getVaultStatus,
  encryptPasswordWithVault,
  decryptPasswordWithVault,
} from "../services/vault.service.js";

describe("vault.service", () => {
  beforeEach(async () => {
    await prisma.systemVault.deleteMany();
  });

  it("reports uninitialized vault initially", async () => {
    const status = await getVaultStatus("token123");
    expect(status.isInitialized).toBe(false);
    expect(status.isUnlocked).toBe(false);
  });

  it("initializes vault and unlocks it for the session", async () => {
    const res = await initVault("SecretPassphrase123!", "sessionA");
    expect(res.ok).toBe(true);

    const status = await getVaultStatus("sessionA");
    expect(status.isInitialized).toBe(true);
    expect(status.isUnlocked).toBe(true);

    const otherStatus = await getVaultStatus("sessionB");
    expect(otherStatus.isInitialized).toBe(true);
    expect(otherStatus.isUnlocked).toBe(false);
  });

  it("rejects invalid passphrase on unlock", async () => {
    await initVault("CorrectPassphrase1!", "sessionA");

    await expect(unlockVault("WrongPassphrase!", "sessionB")).rejects.toThrow("Invalid vault passphrase");
    const status = await getVaultStatus("sessionB");
    expect(status.isUnlocked).toBe(false);
  });

  it("unlocks with correct passphrase and encrypts/decrypts v2 payloads", async () => {
    await initVault("CorrectPassphrase1!", "sessionA");
    await unlockVault("CorrectPassphrase1!", "sessionB");

    const encrypted = encryptPasswordWithVault("SuperSecretPassword", "sessionB");
    expect(encrypted.startsWith("v2.")).toBe(true);

    const decrypted = await decryptPasswordWithVault(encrypted, "sessionB");
    expect(decrypted).toBe("SuperSecretPassword");
  });

  it("locks vault when requested", async () => {
    await initVault("CorrectPassphrase1!", "sessionA");
    lockVault("sessionA");

    const status = await getVaultStatus("sessionA");
    expect(status.isUnlocked).toBe(false);
  });
});
