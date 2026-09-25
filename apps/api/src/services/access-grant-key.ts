import { createHash } from "node:crypto";
import { parseTemporaryPublicKey, type ParsedTemporaryPublicKey, type TemporaryKeyType } from "@inv/shared";

/**
 * Strict validation of a public key that is about to be appended to someone's
 * authorized_keys as root.
 *
 * The shared parser (packages/shared/src/schemas/access-grant.ts) checks the
 * line's shape: one line, an allowed type first (so no `command="…"` / `from=`
 * options), a base64 body, a comment of inert characters. This module then
 * decodes the body and checks it is a well-formed SSH wire-format key of the
 * declared type — a line that merely looks right is not enough — and computes
 * the OpenSSH SHA256 fingerprint, which is what `ssh-keygen -lf` prints and
 * what sshd logs on every login with the key.
 */

export class InvalidPublicKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublicKeyError";
  }
}

export interface ValidatedPublicKey extends ParsedTemporaryPublicKey {
  /** The decoded key blob. */
  blob: Buffer;
  /** "SHA256:<unpadded base64>", identical to `ssh-keygen -lf`. */
  fingerprint: string;
}

/** OpenSSH's fingerprint format: SHA256 over the decoded blob, base64 without padding. */
export function sshKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Split an SSH wire-format blob into its length-prefixed strings; null when malformed. */
function readSshStrings(blob: Buffer): Buffer[] | null {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < blob.length) {
    if (off + 4 > blob.length) return null;
    const len = blob.readUInt32BE(off);
    off += 4;
    if (len > blob.length - off) return null;
    parts.push(blob.subarray(off, off + len));
    off += len;
    if (parts.length > 8) return null;
  }
  return parts;
}

/** Bit length of an SSH mpint (big-endian, possibly with a leading 0x00). */
function mpintBits(n: Buffer): number {
  let i = 0;
  while (i < n.length && n[i] === 0) i++;
  if (i === n.length) return 0;
  return (n.length - i - 1) * 8 + (32 - Math.clz32(n[i]!));
}

const ECDSA_POINT_BYTES: Record<string, number> = { nistp256: 65, nistp384: 97, nistp521: 133 };

/** Check the decoded fields against the declared type; returns an error message or null. */
function checkKeyStructure(type: TemporaryKeyType, parts: Buffer[]): string | null {
  const count = (n: number) => (parts.length === n ? null : "The key data is malformed");
  switch (type) {
    case "ssh-ed25519":
      return count(2) ?? (parts[1]!.length === 32 ? null : "The Ed25519 key has the wrong length");
    case "sk-ssh-ed25519@openssh.com":
      return count(3) ?? (parts[1]!.length === 32 && parts[2]!.length > 0 ? null : "The security-key Ed25519 key is malformed");
    case "ssh-rsa": {
      const bad = count(3);
      if (bad) return bad;
      const bits = mpintBits(parts[2]!);
      if (bits < 2048) return `RSA keys must be at least 2048 bits (this one is ${bits})`;
      if (bits > 16384) return "The RSA key is too large";
      return null;
    }
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521": {
      const bad = count(3);
      if (bad) return bad;
      const curve = type.slice("ecdsa-sha2-".length);
      if (parts[1]!.toString("latin1") !== curve) return "The ECDSA key's curve does not match its type";
      return parts[2]!.length === ECDSA_POINT_BYTES[curve] && parts[2]![0] === 0x04 ? null : "The ECDSA key point is malformed";
    }
    case "sk-ecdsa-sha2-nistp256@openssh.com": {
      const bad = count(4);
      if (bad) return bad;
      if (parts[1]!.toString("latin1") !== "nistp256") return "The security-key ECDSA key's curve does not match its type";
      return parts[2]!.length === 65 && parts[2]![0] === 0x04 && parts[3]!.length > 0 ? null : "The security-key ECDSA key is malformed";
    }
  }
}

/**
 * Validate a pasted public key and return its normalised form plus fingerprint.
 * Throws InvalidPublicKeyError with an operator-facing message.
 */
export function validateTemporaryPublicKey(raw: string): ValidatedPublicKey {
  const parsed = parseTemporaryPublicKey(raw);
  if (!parsed.ok) throw new InvalidPublicKeyError(parsed.error);
  const { key } = parsed;

  const blob = Buffer.from(key.body, "base64");
  // Buffer.from() skips characters it does not understand; a strict round trip
  // proves the body was canonical base64 and nothing was silently dropped.
  if (blob.length === 0 || blob.toString("base64") !== key.body) {
    throw new InvalidPublicKeyError("The key body is not valid base64");
  }
  const parts = readSshStrings(blob);
  if (!parts || parts.length === 0) throw new InvalidPublicKeyError("The key data is malformed");
  if (parts[0]!.toString("latin1") !== key.type) {
    throw new InvalidPublicKeyError(`The key data is not a ${key.type} key`);
  }
  const structural = checkKeyStructure(key.type, parts);
  if (structural) throw new InvalidPublicKeyError(structural);

  return { ...key, blob, fingerprint: sshKeyFingerprint(blob) };
}
