import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { prisma } from "../db.js";
import { connectToServer, SshError } from "./ssh.service.js";
import type { SshKeyInfo, AddSshKeyInput, SshKeyTestResult } from "@inv/shared";

const CUSTOM_KEYS_DIR = "/data/ssh_keys";

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * OpenSSH-style fingerprint of the PUBLIC key.
 *
 * Never hash private key bytes: the result is returned to clients, and a hash
 * of private material is a secret-derived value that should not leave the host.
 * Prefers the real OpenSSH fingerprint (SHA-256 over the public key blob) when
 * a .pub file is available, and otherwise derives the public key from the
 * private one and hashes its SPKI DER.
 */
function computeFingerprint(privateKeyPem: string | Buffer, publicKeyText?: string): string {
  // Preferred: the authentic OpenSSH fingerprint, from the base64 blob in the .pub file.
  if (publicKeyText) {
    const blob = publicKeyText.trim().split(/\s+/)[1];
    if (blob) {
      try {
        const hash = crypto.createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
        return `SHA256:${hash.replace(/=+$/, "")}`;
      } catch {
        // fall through to deriving from the private key
      }
    }
  }

  // Fallback: derive the public key, hash its SPKI DER. Not an OpenSSH
  // fingerprint, but still public-key-derived and stable per key.
  try {
    const spki = crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
    const hash = crypto.createHash("sha256").update(spki).digest("base64");
    return `SHA256:${hash.replace(/=+$/, "")}`;
  } catch {
    return "unknown";
  }
}

function detectKeyType(content: string): "ed25519" | "rsa" | "ecdsa" | "unknown" {
  const c = content.toLowerCase();
  if (c.includes("ed25519")) return "ed25519";
  if (c.includes("rsa")) return "rsa";
  if (c.includes("ecdsa") || c.includes("ec private")) return "ecdsa";
  return "unknown";
}

export async function listSshKeys(): Promise<SshKeyInfo[]> {
  ensureDir(CUSTOM_KEYS_DIR);
  const keys: SshKeyInfo[] = [];

  // 1. Host default keys
  const hostKeyPaths = [
    { path: "/data/id_ed25519", name: "Host Default Key (ED25519)" },
    { path: "/data/id_rsa", name: "Host Default Key (RSA)" },
    { path: "/root/.ssh/id_ed25519", name: "Root ED25519 Key" },
    { path: "/root/.ssh/id_rsa", name: "Root RSA Key" },
    { path: path.join(os.homedir(), ".ssh", "id_ed25519"), name: "Host System Key (ED25519)" },
    { path: path.join(os.homedir(), ".ssh", "id_rsa"), name: "Host System Key (RSA)" },
  ];

  const seenPaths = new Set<string>();

  for (const item of hostKeyPaths) {
    if (fs.existsSync(item.path) && !seenPaths.has(item.path)) {
      try {
        const content = fs.readFileSync(item.path, "utf8");
        const keyType = detectKeyType(content);
        const pubPath = `${item.path}.pub`;
        const publicKey = fs.existsSync(pubPath) ? fs.readFileSync(pubPath, "utf8").trim() : undefined;
        const fp = computeFingerprint(content, publicKey);

        seenPaths.add(item.path);
        keys.push({
          id: `host:${path.basename(item.path)}`,
          name: item.name,
          keyType,
          fingerprint: fp,
          publicKey,
          source: "host",
          isDefault: item.path.includes("id_ed25519"),
          boundServers: [],
        });
      } catch {
        // ignore unreadable
      }
    }
  }

  // 2. Custom added keys in /data/ssh_keys/
  try {
    const files = fs.readdirSync(CUSTOM_KEYS_DIR);
    for (const file of files) {
      if (file.endsWith(".pem") || file.endsWith(".key")) {
        const keyPath = path.join(CUSTOM_KEYS_DIR, file);
        const baseId = file.replace(/\.(pem|key)$/, "");
        const metaPath = path.join(CUSTOM_KEYS_DIR, `${baseId}.json`);

        let metaName = `Custom Key (${baseId})`;
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            if (meta.name) metaName = meta.name;
          } catch {
            // ignore meta parse error
          }
        }

        try {
          const content = fs.readFileSync(keyPath, "utf8");
          const keyType = detectKeyType(content);
          const fp = computeFingerprint(content);

          keys.push({
            id: `custom:${baseId}`,
            name: metaName,
            keyType,
            fingerprint: fp,
            source: "custom",
            isDefault: false,
            boundServers: [],
          });
        } catch {
          // ignore unreadable
        }
      }
    }
  } catch {
    // ignore read error
  }

  // 3. Map servers associated with these keys
  const servers = await prisma.server.findMany({
    where: { deletedAt: null },
    select: { id: true, hostname: true, ip: true },
  });

  for (const k of keys) {
    if (k.isDefault) {
      k.boundServers = servers.map((s) => ({ id: s.id, hostname: s.hostname, ip: s.ip }));
    }
  }

  return keys;
}

export async function addSshKey(input: AddSshKeyInput): Promise<SshKeyInfo> {
  ensureDir(CUSTOM_KEYS_DIR);
  const id = `key_${Date.now()}`;
  const keyPath = path.join(CUSTOM_KEYS_DIR, `${id}.pem`);
  const metaPath = path.join(CUSTOM_KEYS_DIR, `${id}.json`);

  fs.writeFileSync(keyPath, input.privateKey.trim() + "\n", { mode: 0o600 });
  const keyType = detectKeyType(input.privateKey);
  const fp = computeFingerprint(input.privateKey);

  const meta = {
    id,
    name: input.name,
    keyType,
    fingerprint: fp,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });

  return {
    id: `custom:${id}`,
    name: input.name,
    keyType,
    fingerprint: fp,
    source: "custom",
    isDefault: false,
    boundServers: [],
  };
}

export async function removeSshKey(keyId: string): Promise<{ success: boolean; message: string }> {
  if (!keyId.startsWith("custom:")) {
    throw new Error("Cannot remove host system keys from disk. Only custom added keys can be removed.");
  }
  const baseId = keyId.replace("custom:", "");
  const keyPath = path.join(CUSTOM_KEYS_DIR, `${baseId}.pem`);
  const metaPath = path.join(CUSTOM_KEYS_DIR, `${baseId}.json`);

  if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

  return { success: true, message: "SSH key removed successfully" };
}

export async function testServerSshKey(
  serverId: number,
  keyIdOrOptions?: string | { authMethod?: "auto" | "key" | "password"; password?: string; keyId?: string }
): Promise<SshKeyTestResult> {
  const opts =
    typeof keyIdOrOptions === "string"
      ? { keyId: keyIdOrOptions, authMethod: "key" as const }
      : keyIdOrOptions || { authMethod: "auto" as const };

  const start = Date.now();
  try {
    const { client, authMethodUsed } = await connectToServer(serverId, {
      overridePassword: opts.password,
      preferredAuth: opts.authMethod,
      keyId: opts.keyId,
    });
    const latency = Date.now() - start;
    client.end();
    const methodLabel = authMethodUsed === "password" ? "Password" : "SSH Key";
    return {
      success: true,
      latencyMs: latency,
      authMethodUsed,
      message: `${methodLabel} authentication verified successfully (${latency}ms round-trip latency)`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: err.message || "Failed to authenticate with server",
    };
  }
}
