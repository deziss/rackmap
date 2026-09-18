import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../db.js";
import {
  initVault,
  unlockVault,
  lockVault,
  resetVault,
  getVaultStatus,
  encryptPasswordWithVault,
  decryptPasswordWithVault,
} from "../services/vault.service.js";
import { getAppEncryptionKey, encryptSecret, decryptSecret } from "../lib/crypto.js";

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

  it("resets vault with a new passphrase when requested", async () => {
    await initVault("OldPassphrase123!", "sessionA");
    const resetRes = await resetVault("NewPassphrase456!", "sessionReset");
    expect(resetRes.ok).toBe(true);

    // Old passphrase fails
    await expect(unlockVault("OldPassphrase123!", "sessionX")).rejects.toThrow("Invalid vault passphrase");

    // New passphrase succeeds
    const unlockRes = await unlockVault("NewPassphrase456!", "sessionX");
    expect(unlockRes.ok).toBe(true);

    const status = await getVaultStatus("sessionX");
    expect(status.isUnlocked).toBe(true);
  });

  it("supports symmetric encryption and decryption with key derivation", () => {
    const key = getAppEncryptionKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);

    const ciphertext = encryptSecret("MyTestPassword");
    expect(ciphertext.startsWith("v1.")).toBe(true);

    const plaintext = decryptSecret(ciphertext);
    expect(plaintext).toBe("MyTestPassword");
  });
});
