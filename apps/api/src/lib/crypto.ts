import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.js";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

function key() {
  return Buffer.from(env.APP_ENCRYPTION_KEY, "base64");
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
