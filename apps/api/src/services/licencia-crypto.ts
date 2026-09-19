import crypto from "node:crypto";
import os from "node:os";

const ISSUER = "licencia";
const KNOWN_TYPES = new Set(["LIC", "LEA", "ACT"]);

export function base64urlDecode(str: string): Buffer {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

export interface VerifyOpts {
  expectedTenantId?: string;
  now?: number;
}

export interface VerifiedLicense {
  header: {
    typ: string;
    alg: string;
    [key: string]: unknown;
  };
  payload: {
    iss: string;
    sub?: string;
    tid?: string;
    iat?: number;
    exp?: number;
    ent?: {
      product?: string;
      tier?: "free" | "pro" | "enterprise";
      features?: Record<string, boolean>;
      limits?: Record<string, number>;
      [key: string]: unknown;
    };
    pid?: string;
    gra?: number;
    [key: string]: unknown;
  };
  typ: string;
}

/**
 * Verify a Licencia signed blob (LIC or LEA).
 * Zero-dependency Ed25519 verification using Node.js crypto.
 */
export function verifyLicenseToken(token: string, publicKeyPem: string, opts: VerifyOpts = {}): VerifiedLicense {
  const parts = String(token).trim().split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed license token: expected 3 dot-separated parts");
  }
  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "ascii");
  const signature = base64urlDecode(sigB64);
  const publicKey = crypto.createPublicKey(publicKeyPem);

  // Ed25519 uses null digest
  if (!crypto.verify(null, signingInput, publicKey, signature)) {
    throw new Error("Invalid signature: license signature verification failed");
  }

  const header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
  const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  if (payload.iss !== ISSUER) {
    throw new Error(`Unexpected issuer: ${payload.iss}`);
  }
  if (!KNOWN_TYPES.has(header.typ)) {
    throw new Error(`Unexpected token type: ${header.typ}`);
  }

  if (opts.expectedTenantId != null && header.typ === "LIC" && payload.tid !== opts.expectedTenantId) {
    throw new Error("Tenant mismatch");
  }
  if (payload.exp != null && payload.exp <= now) {
    throw new Error("License expired");
  }

  return { header, payload, typ: header.typ };
}

/** Check if sub matches sha256(licenseKey)[0..16] */
export function subMatches(payload: { sub?: string }, licenseKey: string): boolean {
  if (!payload.sub) return false;
  const digest = crypto.createHash("sha256").update(licenseKey, "utf8").digest("hex");
  return payload.sub === digest.slice(0, 16);
}

/** Generate a stable hardware fingerprint: SHA-256(hostname + MAC) */
export function generateHardwareFingerprint(): string {
  const hostname = os.hostname();
  const ifaces = os.networkInterfaces();
  let mac = "";

  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) continue;
    for (const net of list) {
      if (!net.internal && net.mac && net.mac !== "00:00:00:00:00:00") {
        mac = net.mac;
        break;
      }
    }
    if (mac) break;
  }

  return crypto.createHash("sha256").update(`${hostname}:${mac}`).digest("hex").slice(0, 32);
}
