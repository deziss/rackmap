import crypto from "node:crypto";
import { prisma } from "../db.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32; // 256-bit KEK
const PBKDF2_DIGEST = "sha512";
const VERIFIER_MESSAGE = "rackmap-vault-verifier-v1";
const DEFAULT_AUTO_LOCK_MINUTES = 30;

// Ephemeral in-memory unlocked vault keys indexed by session token
interface UnlockedSession {
  dek: Buffer;
  expiresAt: number;
}
const activeSessions = new Map<string, UnlockedSession>();

function deriveKek(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
}

function computeVerifier(kek: Buffer): string {
  return crypto.createHmac("sha256", kek).update(VERIFIER_MESSAGE).digest("hex");
}

function aesEncrypt(key: Buffer, plaintext: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${ciphertext.toString("hex")}`;
}

function aesDecrypt(key: Buffer, payload: string): Buffer | null {
  try {
    const [ivHex, tagHex, dataHex] = payload.split(".");
    if (!ivHex || !tagHex || !dataHex) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  } catch {
    return null;
  }
}

/** Get status of the system vault */
export async function getVaultStatus(sessionToken?: string) {
  const vault = await prisma.systemVault.findFirst({ where: { id: 1 } });
  const isInitialized = vault !== null;

  let isUnlocked = false;
  let expiresAt: string | null = null;

  if (sessionToken && activeSessions.has(sessionToken)) {
    const session = activeSessions.get(sessionToken)!;
    if (Date.now() < session.expiresAt) {
      isUnlocked = true;
      expiresAt = new Date(session.expiresAt).toISOString();
    } else {
      activeSessions.delete(sessionToken);
    }
  }

  return {
    isInitialized,
    isUnlocked,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
    expiresAt,
  };
}

/** Initialize master vault with user passphrase */
export async function initVault(passphrase: string, sessionToken?: string) {
  const existing = await prisma.systemVault.findFirst({ where: { id: 1 } });
  if (existing) {
    throw new Error("Vault is already initialized");
  }

  const salt = crypto.randomBytes(16);
  const kek = deriveKek(passphrase, salt);
  const verifier = computeVerifier(kek);

  // Generate random 256-bit DEK
  const dek = crypto.randomBytes(32);
  const encryptedDek = aesEncrypt(kek, dek);

  await prisma.systemVault.create({
    data: {
      id: 1,
      salt: salt.toString("hex"),
      verifier,
      encryptedDek,
    },
  });

  if (sessionToken) {
    activeSessions.set(sessionToken, {
      dek,
      expiresAt: Date.now() + DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000,
    });
  }

  return { ok: true };
}

/** Unlock vault for the current authenticated user session */
export async function unlockVault(passphrase: string, sessionToken: string) {
  const vault = await prisma.systemVault.findFirst({ where: { id: 1 } });
  if (!vault) {
    throw new Error("Vault is not initialized. Please set up a master vault passphrase.");
  }

  const salt = Buffer.from(vault.salt, "hex");
  const kek = deriveKek(passphrase, salt);
  const expectedVerifier = computeVerifier(kek);

  // Constant-time compare verifiers to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(expectedVerifier, "hex"), Buffer.from(vault.verifier, "hex"))) {
    throw new Error("Invalid vault passphrase");
  }

  const dek = aesDecrypt(kek, vault.encryptedDek);
  if (!dek) {
    throw new Error("Failed to decrypt vault key");
  }

  activeSessions.set(sessionToken, {
    dek,
    expiresAt: Date.now() + DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000,
  });

  return {
    ok: true,
    expiresAt: new Date(Date.now() + DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000).toISOString(),
  };
}

/** Lock vault for the current session */
export function lockVault(sessionToken: string) {
  activeSessions.delete(sessionToken);
  return { ok: true };
}

/**
 * Encrypt a password.
 * Uses vault DEK (format v2.<iv>.<tag>.<cipher>) if unlocked.
 * Falls back to APP_ENCRYPTION_KEY (format v1.<iv>.<tag>.<cipher>).
 */
export function encryptPasswordWithVault(plaintext: string, sessionToken?: string): string {
  if (sessionToken && activeSessions.has(sessionToken)) {
    const session = activeSessions.get(sessionToken)!;
    if (Date.now() < session.expiresAt) {
      const encrypted = aesEncrypt(session.dek, Buffer.from(plaintext, "utf8"));
      return `v2.${encrypted}`;
    }
  }
  // Standard fallback
  return encryptSecret(plaintext);
}

/**
 * Decrypt a password.
 * Supports v2 (vault DEK) and v1 (APP_ENCRYPTION_KEY).
 */
export async function decryptPasswordWithVault(ciphertext: string, sessionToken?: string): Promise<string | null> {
  if (ciphertext.startsWith("v2.")) {
    const payload = ciphertext.slice(3);
    // 1. Check if specific session has DEK
    if (sessionToken && activeSessions.has(sessionToken)) {
      const session = activeSessions.get(sessionToken)!;
      if (Date.now() < session.expiresAt) {
        const dec = aesDecrypt(session.dek, payload);
        if (dec) return dec.toString("utf8");
      }
    }
    // 2. Fallback: Check if any active user session in memory has an unlocked DEK
    for (const session of activeSessions.values()) {
      if (Date.now() < session.expiresAt) {
        const dec = aesDecrypt(session.dek, payload);
        if (dec) return dec.toString("utf8");
      }
    }
    // 3. Fallback: check if fallback APP_ENCRYPTION_KEY can decrypt
    const fallback = decryptSecret(ciphertext);
    if (fallback) return fallback;
    throw new Error("Vault is locked. Enter your vault passphrase to decrypt this password.");
  }

  // v1 legacy format uses APP_ENCRYPTION_KEY
  return decryptSecret(ciphertext);
}
