import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../env.js";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

/**
 * Returns a 32-byte Buffer key for AES-256-GCM encryption.
 * Supports:
 * 1. Base64 32-byte key (standard openssl rand -base64 32, 44 chars ending in =)
 * 2. Arbitrary human-readable passphrase (derived via SHA-256)
 */
export function getAppEncryptionKey(): Buffer {
  const raw = (env.APP_ENCRYPTION_PASSPHRASE || env.APP_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw new Error("Neither APP_ENCRYPTION_KEY nor APP_ENCRYPTION_PASSPHRASE is configured");
  }

  // If provided as a 32-byte base64 string, preserve exact binary key for backwards compatibility
  if (raw.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    try {
      const b64 = Buffer.from(raw, "base64");
      if (b64.length === 32 && b64.toString("base64") === raw) {
        return b64;
      }
    } catch {
      // fallback to sha256
    }
  }

  // Otherwise, derive 32-byte AES key from passphrase
  return createHash("sha256").update(raw, "utf8").digest();
}

function key(): Buffer {
  return getAppEncryptionKey();
}

/** Encrypt a plaintext password. Returns "v1.<iv_hex>.<tag_hex>.<ct_hex>" */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("hex")}.${tag.toString("hex")}.${ct.toString("hex")}`;
}

/** Decrypt a blob produced by encryptSecret. Returns null on any failure. */
export function decryptSecret(blob: string): string | null {
  try {
    const parts = blob.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    const [, ivHex, tagHex, ctHex] = parts;
    if (!ivHex || !tagHex || !ctHex) return null;
    const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}
