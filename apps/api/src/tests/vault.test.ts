import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../db.js";
import {
  initVault,
  unlockVault,
  lockVault,
  resetVault,
  getVaultStatus,
  encryptPasswordWithVault,
  decryptPasswordWithVault,
  reencryptPasswordForStorage,
  sweepExpiredSessions,
} from "../services/vault.service.js";
import {
  getAppEncryptionKey,
  encryptSecret,
  decryptSecret,
  decryptSecretDetailed,
  isLegacySecret,
  upgradeLegacySecret,
} from "../lib/crypto.js";

/**
 * Frozen legacy blob: AES-256-GCM under the raw APP_ENCRYPTION_KEY from tests/setup.ts,
 * in the original unsalted "v1.<iv>.<tag>.<ct>" shape. This literal stands in for the
 * production rows that were written before the scrypt envelope existed — it must keep
 * decrypting without any migration.
 */
const LEGACY_V1_BLOB =
  "v1.5ae45e5617e83288a054a779.6034ead9a68d2da3ac16d291bdaeb9a0.8ba658596d1dcec9cc42738a43904f8dff9a2de0";
const LEGACY_V1_PLAINTEXT = "LegacyStoredPassword";

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

  describe("per-session scoping", () => {
    it("does not let operator B use operator A's unlocked vault", async () => {
      await initVault("SharedPassphrase1!", "iso-init");
      await unlockVault("SharedPassphrase1!", "iso-operator-A");

      const blob = encryptPasswordWithVault("OperatorASecret", "iso-operator-A");
      expect(blob.startsWith("v2.")).toBe(true);

      // A can read its own credential…
      await expect(decryptPasswordWithVault(blob, "iso-operator-A")).resolves.toBe("OperatorASecret");

      // …B, who never unlocked, cannot — and is told the vault is locked for them.
      await expect(decryptPasswordWithVault(blob, "iso-operator-B")).rejects.toThrow(/Vault is locked/);

      // A request with no session at all has no operator DEK to borrow either.
      await expect(decryptPasswordWithVault(blob)).rejects.toThrow(/Vault is locked/);

      // And B's status still reports locked while A is unlocked.
      expect((await getVaultStatus("iso-operator-B")).isUnlocked).toBe(false);
      expect((await getVaultStatus("iso-operator-A")).isUnlocked).toBe(true);
    });

    it("does not encrypt under another operator's key when the caller is locked", async () => {
      await initVault("SharedPassphrase2!", "enc-init");
      await unlockVault("SharedPassphrase2!", "enc-operator-A");

      // B has no session DEK and there is no system session, so this must fall back to the
      // APP_ENCRYPTION_KEY envelope rather than silently borrowing A's vault key.
      const blob = encryptPasswordWithVault("BeeSecret", "enc-operator-B");
      expect(blob.startsWith("v2.")).toBe(false);
      expect(blob.startsWith("v3.")).toBe(true);
      expect(await decryptPasswordWithVault(blob, "enc-operator-B")).toBe("BeeSecret");
    });

    it("sweeps expired sessions out of memory", async () => {
      await initVault("SweepPassphrase1!", "sweep-init");
      await unlockVault("SweepPassphrase1!", "sweep-session");
      expect((await getVaultStatus("sweep-session")).isUnlocked).toBe(true);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 31 * 60 * 1000);
        expect(sweepExpiredSessions()).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }

      expect((await getVaultStatus("sweep-session")).isUnlocked).toBe(false);
    });
  });

  describe("resetVault", () => {
    it("refuses to reset without the current passphrase", async () => {
      await initVault("OldPassphrase123!", "reset-init");

      await expect(resetVault({ newPassphrase: "NewPassphrase456!" })).rejects.toThrow(
        /current vault passphrase is required/i,
      );

      // The vault is untouched: the old passphrase still unlocks it.
      const unlockRes = await unlockVault("OldPassphrase123!", "reset-check");
      expect(unlockRes.ok).toBe(true);
    });

    it("refuses to reset with a wrong current passphrase", async () => {
      await initVault("OldPassphrase123!", "reset-init-2");

      await expect(
        resetVault({ newPassphrase: "NewPassphrase456!", currentPassphrase: "NotTheOne!" }),
      ).rejects.toThrow("Invalid vault passphrase");

      expect((await unlockVault("OldPassphrase123!", "reset-check-2")).ok).toBe(true);
    });

    it("re-keys with the current passphrase and keeps existing credentials decryptable", async () => {
      await initVault("OldPassphrase123!", "rekey-A");
      const blob = encryptPasswordWithVault("SurvivesRekey", "rekey-A");
      expect(blob.startsWith("v2.")).toBe(true);

      const resetRes = await resetVault({
        newPassphrase: "NewPassphrase456!",
        currentPassphrase: "OldPassphrase123!",
        sessionToken: "rekey-B",
      });
      expect(resetRes.ok).toBe(true);
      expect(resetRes.mode).toBe("rekeyed");

      // Old passphrase no longer unlocks…
      await expect(unlockVault("OldPassphrase123!", "rekey-C")).rejects.toThrow("Invalid vault passphrase");

      // …the new one does, and the pre-existing credential still decrypts.
      expect((await unlockVault("NewPassphrase456!", "rekey-C")).ok).toBe(true);
      expect(await decryptPasswordWithVault(blob, "rekey-C")).toBe("SurvivesRekey");
    });

    it("only orphans credentials on the explicit destructive path", async () => {
      await initVault("OldPassphrase123!", "destroy-A");
      const blob = encryptPasswordWithVault("LostForever", "destroy-A");

      const resetRes = await resetVault({
        newPassphrase: "BrandNewPassphrase1!",
        forceDestroy: true,
        sessionToken: "destroy-B",
      });
      expect(resetRes.ok).toBe(true);
      expect(resetRes.mode).toBe("destroyed");

      // Every previously unlocked session was dropped.
      expect((await getVaultStatus("destroy-A")).isUnlocked).toBe(false);

      // The old credential is unreadable under the new DEK.
      await expect(decryptPasswordWithVault(blob, "destroy-B")).rejects.toThrow(
        /encrypted with a different vault key/,
      );

      // The new passphrase works for new material.
      const fresh = encryptPasswordWithVault("BrandNewSecret", "destroy-B");
      expect(await decryptPasswordWithVault(fresh, "destroy-B")).toBe("BrandNewSecret");
    });

    it("treats a reset of an uninitialized vault as a first initialization", async () => {
      const res = await resetVault({ newPassphrase: "FirstPassphrase1!", sessionToken: "fresh-A" });
      expect(res.mode).toBe("initialized");
      expect((await getVaultStatus("fresh-A")).isUnlocked).toBe(true);
    });
  });
});

describe("lib/crypto envelopes", () => {
  it("still decrypts legacy v1 blobs written before the scrypt envelope existed", () => {
    expect(isLegacySecret(LEGACY_V1_BLOB)).toBe(true);
    expect(decryptSecret(LEGACY_V1_BLOB)).toBe(LEGACY_V1_PLAINTEXT);
  });

  it("routes legacy v1 blobs through the vault decrypt path unchanged", async () => {
    await expect(decryptPasswordWithVault(LEGACY_V1_BLOB)).resolves.toBe(LEGACY_V1_PLAINTEXT);
  });

  it("writes the salted scrypt envelope and round-trips it", () => {
    const key = getAppEncryptionKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);

    const ciphertext = encryptSecret("MyTestPassword");
    expect(ciphertext.startsWith("v3.")).toBe(true);

    const [version, kdf, saltHex] = ciphertext.split(".");
    expect(version).toBe("v3");
    expect(kdf).toBe("scrypt-16384-8-1");
    expect(saltHex).toHaveLength(32); // 16 random bytes, hex

    expect(decryptSecret(ciphertext)).toBe("MyTestPassword");
  });

  it("uses a fresh salt and iv for every blob", () => {
    const a = encryptSecret("SamePlaintext");
    const b = encryptSecret("SamePlaintext");
    expect(a).not.toBe(b);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
    expect(decryptSecret(a)).toBe("SamePlaintext");
    expect(decryptSecret(b)).toBe("SamePlaintext");
  });

  it("distinguishes an unknown format from a failed decryption without leaking to callers", () => {
    expect(decryptSecretDetailed("not-a-blob")).toEqual({ ok: false, reason: "unsupported-format" });
    // v2 belongs to the vault DEK, not to this module
    expect(decryptSecretDetailed("v2.aaaa.bbbb.cccc")).toEqual({ ok: false, reason: "unsupported-format" });

    const tampered = `${LEGACY_V1_BLOB.slice(0, -2)}00`;
    expect(decryptSecretDetailed(tampered)).toEqual({ ok: false, reason: "decryption-failed" });

    // Public surface is unchanged: still just null.
    expect(decryptSecret("not-a-blob")).toBeNull();
    expect(decryptSecret(tampered)).toBeNull();
  });

  it("lazily upgrades a legacy blob to the new envelope on write-back", () => {
    const upgraded = upgradeLegacySecret(LEGACY_V1_BLOB);
    expect(upgraded).not.toBeNull();
    expect(upgraded!.startsWith("v3.")).toBe(true);
    expect(decryptSecret(upgraded!)).toBe(LEGACY_V1_PLAINTEXT);

    // Nothing to do for values that are already current or not ours.
    expect(upgradeLegacySecret(upgraded!)).toBeNull();
    expect(reencryptPasswordForStorage("v2.aaaa.bbbb.cccc")).toBeNull();
    expect(reencryptPasswordForStorage(LEGACY_V1_BLOB)).not.toBeNull();
  });
});
