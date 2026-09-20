import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { encryptSecret, decryptSecretDetailed, upgradeLegacySecret } from "../lib/crypto.js";
import { currentVaultSessionToken } from "../lib/vault-context.js";

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32; // 256-bit KEK
const PBKDF2_DIGEST = "sha512";
const VERIFIER_MESSAGE = "rackmap-vault-verifier-v1";
const DEFAULT_AUTO_LOCK_MINUTES = 30;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Fixed token for the long-lived *system* session created by VAULT_PASSPHRASE auto-unlock
 * (autoInitVaultFromEnv) and by an explicit admin global unlock (unlockVaultGlobal).
 *
 * Background work — scheduler, alert sweep, metrics collection — is not request scoped and
 * has no operator session, so it decrypts through this session. It is a deliberate,
 * deployment-wide unlock and is only ever consulted through getSystemSessionDek().
 */
export const SYSTEM_SESSION_TOKEN = "__env_system_vault__";

// Ephemeral in-memory unlocked vault keys, indexed by a SHA-256 hash of the session token.
// The raw Better Auth session cookie value is never used as a Map key.
interface UnlockedSession {
  dek: Buffer;
  expiresAt: number;
}
const activeSessions = new Map<string, UnlockedSession>();

/** Never key the session map by the raw bearer/cookie value. */
function sessionKey(sessionToken: string): string {
  return crypto.createHash("sha256").update(sessionToken, "utf8").digest("hex");
}

const SYSTEM_SESSION_KEY = sessionKey(SYSTEM_SESSION_TOKEN);

function storeSession(sessionToken: string, dek: Buffer, expiresAt: number): void {
  const key = sessionKey(sessionToken);
  dropSession(key);
  // Store a private copy so evicting one session can zero its key without touching another's.
  activeSessions.set(key, { dek: Buffer.from(dek), expiresAt });
}

function dropSession(key: string): void {
  const existing = activeSessions.get(key);
  if (existing) {
    existing.dek.fill(0);
    activeSessions.delete(key);
  }
}

function dropAllSessions(): void {
  for (const key of [...activeSessions.keys()]) dropSession(key);
}

/** Evict every session whose auto-lock deadline has passed, zeroing its DEK. */
export function sweepExpiredSessions(now: number = Date.now()): number {
  let evicted = 0;
  for (const [key, session] of [...activeSessions.entries()]) {
    if (now >= session.expiresAt) {
      dropSession(key);
      evicted++;
    }
  }
  return evicted;
}

// Expired DEKs used to linger in memory until something happened to call getVaultStatus for
// that exact token. Sweep on a timer instead; unref'd so it never holds the process open.
const sweepTimer = setInterval(() => sweepExpiredSessions(), SWEEP_INTERVAL_MS);
sweepTimer.unref?.();

/** The DEK for this request's own session, or null. Never falls back to another operator. */
function getSessionDek(sessionToken?: string): Buffer | null {
  if (!sessionToken) return null;
  const key = sessionKey(sessionToken);
  const session = activeSessions.get(key);
  if (!session) return null;
  if (Date.now() >= session.expiresAt) {
    dropSession(key);
    return null;
  }
  return session.dek;
}

/**
 * The DEK of the deployment-wide system session (VAULT_PASSPHRASE / global unlock), or null.
 *
 * This is the only cross-session key path that exists. It is consulted explicitly — for
 * background jobs that have no request session, and for requests made while an admin has
 * deliberately unlocked the vault globally — never by iterating other operators' sessions.
 */
function getSystemSessionDek(): Buffer | null {
  const session = activeSessions.get(SYSTEM_SESSION_KEY);
  if (!session) return null;
  if (Date.now() >= session.expiresAt) {
    dropSession(SYSTEM_SESSION_KEY);
    return null;
  }
  return session.dek;
}

function deriveKek(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
}

function computeVerifier(kek: Buffer): string {
  return crypto.createHmac("sha256", kek).update(VERIFIER_MESSAGE).digest("hex");
}

/** Constant-time verifier comparison that tolerates a malformed stored verifier. */
function verifierMatches(kek: Buffer, storedVerifier: string): boolean {
  const expected = Buffer.from(computeVerifier(kek), "hex");
  let stored: Buffer;
  try {
    stored = Buffer.from(storedVerifier, "hex");
  } catch {
    return false;
  }
  if (stored.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, stored);
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

  const systemDek = getSystemSessionDek();
  const isEnvUnlocked = systemDek !== null;

  let isUnlocked = false;
  let expiresAt: string | null = null;

  if (sessionToken) {
    const key = sessionKey(sessionToken);
    const session = activeSessions.get(key);
    if (session) {
      if (Date.now() < session.expiresAt) {
        isUnlocked = true;
        expiresAt =
          session.expiresAt >= Number.MAX_SAFE_INTEGER - 10000
            ? null
            : new Date(session.expiresAt).toISOString();
      } else {
        dropSession(key);
      }
    }
  }

  if (!isUnlocked && isEnvUnlocked) {
    isUnlocked = true;
    expiresAt = null;
  }

  return {
    isInitialized,
    isUnlocked,
    isGlobalUnlocked: isEnvUnlocked,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
    expiresAt,
    isEnvUnlocked,
  };
}

/** Unlock vault globally for all sessions and background tasks */
export async function unlockVaultGlobal(passphrase: string, persistToEnv: boolean = false) {
  const vault = await prisma.systemVault.findFirst({ where: { id: 1 } });
  if (!vault) {
    throw new Error("Vault is not initialized. Please set up a master vault passphrase.");
  }

  const salt = Buffer.from(vault.salt, "hex");
  const kek = deriveKek(passphrase, salt);

  if (!verifierMatches(kek, vault.verifier)) {
    throw new Error("Invalid vault passphrase");
  }

  const dek = aesDecrypt(kek, vault.encryptedDek);
  if (!dek) {
    throw new Error("Failed to decrypt vault key");
  }

  storeSession(SYSTEM_SESSION_TOKEN, dek, Number.MAX_SAFE_INTEGER);

  if (persistToEnv) {
    // This file also holds BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY, so the write is done
    // atomically (temp file in the same directory + rename) and the result is 0600 — never
    // the world-readable 0644 an in-place rewrite would have left behind.
    const envPath = path.resolve(process.cwd(), ".env");
    const tmpPath = path.join(path.dirname(envPath), `.env.vault-${process.pid}-${Date.now()}.tmp`);
    try {
      let envContent = fs.readFileSync(envPath, "utf8");
      // Anchored per-line match: a commented-out "#VAULT_PASSPHRASE=" line and any
      // "SOMETHING_VAULT_PASSPHRASE=" variable must be left untouched.
      const assignment = /^VAULT_PASSPHRASE=.*$/m;
      if (assignment.test(envContent)) {
        envContent = envContent.replace(assignment, `VAULT_PASSPHRASE=${passphrase}`);
      } else {
        if (envContent.length > 0 && !envContent.endsWith("\n")) envContent += "\n";
        envContent += `VAULT_PASSPHRASE=${passphrase}\n`;
      }
      fs.writeFileSync(tmpPath, envContent, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmpPath, envPath);
      fs.chmodSync(envPath, 0o600);
      process.env.VAULT_PASSPHRASE = passphrase;
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // temp file already gone
      }
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Vault] Failed to persist VAULT_PASSPHRASE to ${envPath}: ${reason}`);
      // Surface it: silently swallowing this left the operator believing the passphrase
      // would survive a restart. The vault itself is unlocked in memory either way.
      throw new Error(
        `Vault unlocked, but persisting the passphrase to .env failed: ${reason}`,
      );
    }
  }

  return { ok: true, isGlobalUnlocked: true };
}

/** Lock vault globally */
export function lockVaultGlobal() {
  dropSession(SYSTEM_SESSION_KEY);
  return { ok: true };
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
    storeSession(sessionToken, dek, Date.now() + DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000);
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

  // Constant-time compare verifiers to prevent timing attacks
  if (!verifierMatches(kek, vault.verifier)) {
    throw new Error("Invalid vault passphrase");
  }

  const dek = aesDecrypt(kek, vault.encryptedDek);
  if (!dek) {
    throw new Error("Failed to decrypt vault key");
  }

  storeSession(sessionToken, dek, Date.now() + DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000);

  return {
    ok: true,
    expiresAt: new Date(Date.now() + DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000).toISOString(),
  };
}

export interface ResetVaultOptions {
  /** The passphrase the vault will be protected with after the operation. */
  newPassphrase: string;
  /** The passphrase currently protecting the vault. Required unless forceDestroy is set. */
  currentPassphrase?: string;
  /**
   * Recovery escape hatch for a genuinely forgotten passphrase.
   *
   * Discards the existing DEK and generates a new one: every credential already encrypted
   * under the old DEK (every "v2." blob) becomes permanently undecryptable and has to be
   * re-entered by hand. Only set this when the current passphrase is truly unrecoverable.
   */
  forceDestroy?: boolean;
  sessionToken?: string;
}

export type ResetVaultMode = "initialized" | "rekeyed" | "destroyed";

/**
 * Re-key the master vault with a new passphrase.
 *
 * Default path ("rekeyed"): requires the current passphrase, and re-wraps the *existing* DEK
 * under the new passphrase, so every stored credential keeps decrypting.
 *
 * Recovery path ("destroyed"): only with forceDestroy, mints a brand new DEK and orphans
 * every credential encrypted under the old one.
 */
export async function resetVault(
  options: ResetVaultOptions,
): Promise<{ ok: true; mode: ResetVaultMode }> {
  const { newPassphrase, currentPassphrase, forceDestroy = false, sessionToken } = options;

  if (!newPassphrase || newPassphrase.length < 8) {
    throw new Error("Vault passphrase must be at least 8 characters long");
  }

  const existing = await prisma.systemVault.findFirst({ where: { id: 1 } });

  let dek: Buffer;
  let mode: ResetVaultMode;

  if (!existing) {
    // Nothing to protect yet — this is really a first initialization.
    dek = crypto.randomBytes(32);
    mode = "initialized";
  } else if (forceDestroy) {
    dek = crypto.randomBytes(32);
    mode = "destroyed";
  } else {
    if (!currentPassphrase) {
      throw new Error(
        "The current vault passphrase is required to re-key the vault. " +
          "If it has been lost, use the explicit destructive recovery option, which permanently " +
          "orphans every stored credential.",
      );
    }
    const oldKek = deriveKek(currentPassphrase, Buffer.from(existing.salt, "hex"));
    if (!verifierMatches(oldKek, existing.verifier)) {
      throw new Error("Invalid vault passphrase");
    }
    const unwrapped = aesDecrypt(oldKek, existing.encryptedDek);
    if (!unwrapped) {
      throw new Error("Failed to decrypt vault key");
    }
    // Keep the same DEK so existing credentials survive the passphrase change.
    dek = unwrapped;
    mode = "rekeyed";
  }

  const salt = crypto.randomBytes(16);
  const kek = deriveKek(newPassphrase, salt);
  const verifier = computeVerifier(kek);
  const encryptedDek = aesEncrypt(kek, dek);

  await prisma.systemVault.upsert({
    where: { id: 1 },
    update: {
      salt: salt.toString("hex"),
      verifier,
      encryptedDek,
    },
    create: {
      id: 1,
      salt: salt.toString("hex"),
      verifier,
      encryptedDek,
    },
  });

  if (mode === "destroyed") {
    // Every in-memory DEK now refers to data that can no longer be read.
    dropAllSessions();
  }

  if (sessionToken) {
    storeSession(sessionToken, dek, Date.now() + DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000);
  }

  // If env.VAULT_PASSPHRASE matches the new passphrase, also unlock system session
  if (env.VAULT_PASSPHRASE && env.VAULT_PASSPHRASE === newPassphrase) {
    storeSession(SYSTEM_SESSION_TOKEN, dek, Number.MAX_SAFE_INTEGER);
  }

  return { ok: true, mode };
}

/**
 * Lock the vault for this session only.
 *
 * The deployment-wide system session (VAULT_PASSPHRASE / global unlock) is deliberately left
 * alone — background jobs depend on it. Use lockVaultGlobal() to drop that one.
 */
export function lockVault(sessionToken: string) {
  dropSession(sessionKey(sessionToken));
  return { ok: true };
}

/**
 * Encrypt a password.
 * Uses the caller's own vault DEK (format v2.<iv>.<tag>.<cipher>) if that session is unlocked,
 * otherwise the deployment-wide system session, otherwise the APP_ENCRYPTION_KEY envelope.
 */
export function encryptPasswordWithVault(plaintext: string, sessionToken?: string): string {
  const own = getSessionDek(sessionToken);
  if (own) {
    return `v2.${aesEncrypt(own, Buffer.from(plaintext, "utf8"))}`;
  }

  // Explicit deployment-wide fallback (background jobs / global unlock) — never another
  // operator's session.
  const system = getSystemSessionDek();
  if (system) {
    return `v2.${aesEncrypt(system, Buffer.from(plaintext, "utf8"))}`;
  }

  // Standard fallback
  return encryptSecret(plaintext);
}

/**
 * Decrypt a password.
 * Supports v2 (vault DEK) and the APP_ENCRYPTION_KEY envelopes (v1 legacy, v3 current).
 */
export async function decryptPasswordWithVault(ciphertext: string, sessionToken?: string): Promise<string | null> {
  if (ciphertext.startsWith("v2.")) {
    const payload = ciphertext.slice(3);

    // 1. This request's own session. Callers that have the token pass it; the
    //    SSH paths do not, so fall back to the ambient request context. There
    //    is no ambient context in background jobs, which correctly drops them
    //    through to the system session below.
    const own = getSessionDek(sessionToken ?? currentVaultSessionToken());
    if (own) {
      const dec = aesDecrypt(own, payload);
      if (dec) return dec.toString("utf8");
    }

    // 2. The deployment-wide system session: VAULT_PASSPHRASE auto-unlock or an explicit
    //    admin global unlock. This is what lets background jobs (scheduler, alert sweep,
    //    metrics) decrypt with no operator session at all.
    const system = getSystemSessionDek();
    if (system) {
      const dec = aesDecrypt(system, payload);
      if (dec) return dec.toString("utf8");
    }

    if (own || system) {
      throw new Error("Unable to decrypt password: The credential was encrypted with a different vault key or passphrase.");
    }

    throw new Error("Vault is locked. Enter your vault passphrase to decrypt this password.");
  }

  // v1 legacy / v3 current envelopes use APP_ENCRYPTION_KEY
  const result = decryptSecretDetailed(ciphertext);
  if (result.ok) return result.plaintext;
  if (result.reason === "decryption-failed") {
    // A wrong APP_ENCRYPTION_KEY otherwise looks exactly like "no password stored".
    console.warn(
      "[Vault] A stored credential failed to authenticate under APP_ENCRYPTION_KEY " +
        "(wrong key, rotated key, or tampered value).",
    );
  }
  return null;
}

/**
 * Lazy upgrade helper for callers that are about to write a credential row back.
 *
 * Returns a re-encrypted blob when the stored value is a legacy unsalted v1 envelope that
 * still decrypts, or null when there is nothing to do (already current, vault-wrapped, or
 * undecryptable) — a null result means "leave the stored column alone".
 */
export function reencryptPasswordForStorage(ciphertext: string): string | null {
  if (!ciphertext || ciphertext.startsWith("v2.")) return null;
  return upgradeLegacySecret(ciphertext);
}

/**
 * Automatically initializes or unlocks the vault at boot
 * if VAULT_PASSPHRASE is specified in .env.
 */
export async function autoInitVaultFromEnv() {
  const passphrase = env.VAULT_PASSPHRASE?.trim();
  if (!passphrase) {
    return;
  }

  try {
    const vault = await prisma.systemVault.findFirst({ where: { id: 1 } });
    if (!vault) {
      console.log("[Vault] Initializing master vault from VAULT_PASSPHRASE environment variable...");
      await initVault(passphrase, SYSTEM_SESSION_TOKEN);
      const session = activeSessions.get(SYSTEM_SESSION_KEY);
      if (session) {
        session.expiresAt = Number.MAX_SAFE_INTEGER;
      }
      console.log("[Vault] Master vault initialized and unlocked via environment.");
    } else {
      console.log("[Vault] Unlocking master vault from VAULT_PASSPHRASE environment variable...");
      await unlockVault(passphrase, SYSTEM_SESSION_TOKEN);
      const session = activeSessions.get(SYSTEM_SESSION_KEY);
      if (session) {
        session.expiresAt = Number.MAX_SAFE_INTEGER;
      }
      console.log("[Vault] Master vault successfully unlocked via environment.");
    }
  } catch (err: any) {
    console.warn(`[Vault] Warning: VAULT_PASSPHRASE could not unlock existing vault: ${err.message}`);
  }
}
