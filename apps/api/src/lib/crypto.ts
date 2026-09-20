import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { env } from "../env.js";

const ALGO = "aes-256-gcm";

/**
 * Envelope versions.
 *
 * - "v1" — legacy: AES-256-GCM under an *unsalted* key (raw 32-byte base64 key, or a single
 *   round of SHA-256 over the passphrase). Still decrypted for backwards compatibility with
 *   live data; never produced any more.
 * - "v2" — RESERVED by services/vault.service.ts for payloads wrapped with the vault DEK.
 *   This module must never emit or claim a "v2." blob.
 * - "v3" — current: AES-256-GCM under a scrypt-derived key with a random per-blob salt.
 */
const LEGACY_VERSION = "v1";
const VERSION = "v3";

// scrypt cost. ~27ms per derivation on a typical server core; results are cached per
// (key material, salt) so the SSH hot path derives at most once per distinct stored blob.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_LEN = 32;
const SALT_BYTES = 16;
const KDF_ID = `scrypt-${SCRYPT_N}-${SCRYPT_R}-${SCRYPT_P}`;

/** Bounded cache of derived keys, keyed by (kdf, salt, fingerprint of the key material). */
const derivedKeyCache = new Map<string, Buffer>();
const DERIVED_KEY_CACHE_MAX = 256;

function rawKeyMaterial(): string {
  const raw = (env.APP_ENCRYPTION_PASSPHRASE || env.APP_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    // Fail closed: refuse to encrypt or decrypt with an implicit/empty key.
    throw new Error("Neither APP_ENCRYPTION_KEY nor APP_ENCRYPTION_PASSPHRASE is configured");
  }
  return raw;
}

/**
 * Returns the 32-byte Buffer key used by the legacy "v1" envelope.
 * Supports:
 * 1. Base64 32-byte key (standard openssl rand -base64 32, 44 chars ending in =)
 * 2. Arbitrary human-readable passphrase (derived via SHA-256)
 *
 * Kept only so existing v1 blobs keep decrypting — new blobs use the scrypt KDF below.
 */
export function getAppEncryptionKey(): Buffer {
  const raw = rawKeyMaterial();

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

function materialFingerprint(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** scrypt(key material, salt) with an in-memory cache so the KDF is not re-run per decrypt. */
function deriveKey(material: string, salt: Buffer): Buffer {
  const cacheId = `${KDF_ID}:${salt.toString("hex")}:${materialFingerprint(material)}`;
  const hit = derivedKeyCache.get(cacheId);
  if (hit) {
    // refresh recency for the simple FIFO/LRU eviction below
    derivedKeyCache.delete(cacheId);
    derivedKeyCache.set(cacheId, hit);
    return hit;
  }

  const key = scryptSync(material, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  if (derivedKeyCache.size >= DERIVED_KEY_CACHE_MAX) {
    const oldest = derivedKeyCache.keys().next();
    if (!oldest.done) derivedKeyCache.delete(oldest.value);
  }
  derivedKeyCache.set(cacheId, key);
  return key;
}

/** Encrypt a plaintext secret. Returns "v3.<kdf>.<salt_hex>.<iv_hex>.<tag_hex>.<ct_hex>". */
export function encryptSecret(plaintext: string): string {
  const material = rawKeyMaterial();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(material, salt), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    KDF_ID,
    salt.toString("hex"),
    iv.toString("hex"),
    tag.toString("hex"),
    ct.toString("hex"),
  ].join(".");
}

export type DecryptFailureReason =
  /** Not a blob this module owns: wrong/unknown version prefix, wrong shape, unknown KDF. */
  | "unsupported-format"
  /** Correct shape, but GCM authentication failed — wrong key, or the blob was tampered with. */
  | "decryption-failed";

export type DecryptSecretResult =
  | { ok: true; plaintext: string; version: typeof LEGACY_VERSION | typeof VERSION }
  | { ok: false; reason: DecryptFailureReason };

function gcmOpen(key: Buffer, ivHex: string, tagHex: string, ctHex: string): string | null {
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/**
 * Decrypt a blob produced by encryptSecret, distinguishing "not our format" from
 * "our format but it would not authenticate" (wrong APP_ENCRYPTION_KEY / tampering).
 *
 * Nothing about the failure is leaked through decryptSecret(); callers that want to tell
 * a misconfigured key apart from "no password stored" opt in by using this function.
 */
export function decryptSecretDetailed(blob: string): DecryptSecretResult {
  if (typeof blob !== "string" || blob.length === 0) {
    return { ok: false, reason: "unsupported-format" };
  }

  const parts = blob.split(".");

  if (parts[0] === VERSION) {
    if (parts.length !== 6) return { ok: false, reason: "unsupported-format" };
    const [, kdfId, saltHex, ivHex, tagHex, ctHex] = parts;
    if (!kdfId || !saltHex || !ivHex || !tagHex || ctHex === undefined) {
      return { ok: false, reason: "unsupported-format" };
    }
    // Only the KDF profile this build knows how to reproduce.
    if (kdfId !== KDF_ID) return { ok: false, reason: "unsupported-format" };

    let key: Buffer;
    try {
      key = deriveKey(rawKeyMaterial(), Buffer.from(saltHex, "hex"));
    } catch {
      return { ok: false, reason: "decryption-failed" };
    }
    const plaintext = gcmOpen(key, ivHex, tagHex, ctHex);
    return plaintext === null
      ? { ok: false, reason: "decryption-failed" }
      : { ok: true, plaintext, version: VERSION };
  }

  if (parts[0] === LEGACY_VERSION) {
    if (parts.length !== 4) return { ok: false, reason: "unsupported-format" };
    const [, ivHex, tagHex, ctHex] = parts;
    if (!ivHex || !tagHex || ctHex === undefined) {
      return { ok: false, reason: "unsupported-format" };
    }
    let key: Buffer;
    try {
      key = getAppEncryptionKey();
    } catch {
      return { ok: false, reason: "decryption-failed" };
    }
    const plaintext = gcmOpen(key, ivHex, tagHex, ctHex);
    return plaintext === null
      ? { ok: false, reason: "decryption-failed" }
      : { ok: true, plaintext, version: LEGACY_VERSION };
  }

  // Includes "v2." (vault DEK envelopes) — not ours to open.
  return { ok: false, reason: "unsupported-format" };
}

/** Decrypt a blob produced by encryptSecret. Returns null on any failure. */
export function decryptSecret(blob: string): string | null {
  const result = decryptSecretDetailed(blob);
  return result.ok ? result.plaintext : null;
}

/** True when the blob is a legacy v1 envelope that should be upgraded on the next write. */
export function isLegacySecret(blob: string): boolean {
  return typeof blob === "string" && blob.startsWith(`${LEGACY_VERSION}.`);
}

/**
 * Lazy upgrade helper: re-encrypt a legacy v1 blob under the current (salted, scrypt) envelope.
 *
 * Callers that are already about to persist a row can pass the stored value through this and
 * write back the result; returns null when there is nothing to upgrade (already current,
 * not ours, or it does not decrypt) so a null result simply means "leave the column alone".
 */
export function upgradeLegacySecret(blob: string): string | null {
  if (!isLegacySecret(blob)) return null;
  const result = decryptSecretDetailed(blob);
  if (!result.ok) return null;
  return encryptSecret(result.plaintext);
}
