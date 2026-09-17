import * as fs from "node:fs";
import { Client } from "ssh2";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { decryptPasswordWithVault } from "./vault.service.js";
import { resolveTargetHost } from "../lib/target-resolver.js";

export type SshErrorKind = "not_found" | "no_credentials" | "unreachable" | "auth_failed";

export class SshError extends Error {
  readonly kind: SshErrorKind;
  constructor(kind: SshErrorKind, message: string) {
    super(message);
    this.name = "SshError";
    this.kind = kind;
  }
}

export interface SshTarget {
  id: number;
  hostname: string;
  ip: string;
  username: string;
  sshPort: number;
}

/**
 * Builds a sudo-elevated command string.
 * If password is provided, uses `echo <password> | sudo -S -p '' <cmd>`
 * Otherwise falls back to passwordless `sudo -n <cmd> 2>/dev/null || <cmd>`.
 */
export function buildSudoCommand(cmd: string, password?: string): string {
  if (password) {
    const escaped = password.replace(/'/g, "'\\''");
    return `echo '${escaped}' | sudo -S -p '' ${cmd}`;
  }
  return `sudo -n ${cmd} 2>/dev/null || ${cmd}`;
}

/**
 * Open an authenticated ssh2 Client to a server.
 * Authentication precedence:
 * 1. SSH Private Key (Host key ~/.ssh/*, /data/id_*, or custom key)
 * 2. Password fallback (decrypted from Vault or override)
 * 3. Both (Key for SSH connection, Password retained for sudo elevation)
 */
export async function connectToServer(
  serverId: number,
  overridePassword?: string,
): Promise<{ client: Client; target: SshTarget; password?: string }> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, hostname: true, ip: true, username: true, sshPort: true, passwordEnc: true, deletedAt: true },
  });
  if (!server || server.deletedAt) throw new SshError("not_found", "Server not found");

  let password: string | undefined;
  let privateKey: string | Buffer | undefined;

  // 1. Search for available SSH private keys on host or storage
  const keyCandidates = [
    process.env.SSH_PRIVATE_KEY_PATH,
    "/data/id_ed25519",
    "/data/id_rsa",
    "/root/.ssh/id_ed25519",
    "/root/.ssh/id_rsa",
    "/home/anshukushwaha/.ssh/id_ed25519",
    "/home/anshukushwaha/.ssh/id_rsa",
  ].filter(Boolean) as string[];

  for (const kp of keyCandidates) {
    if (fs.existsSync(kp)) {
      try {
        privateKey = fs.readFileSync(kp);
        break;
      } catch {
        // ignore unreadable keys
      }
    }
  }

  // 2. Resolve password (override or decrypted from Vault)
  if (overridePassword !== undefined) {
    password = overridePassword;
  } else if (server.passwordEnc) {
    try {
      const decrypted = await decryptPasswordWithVault(server.passwordEnc);
      if (decrypted !== null) {
        password = decrypted;
      }
    } catch (vaultErr: any) {
      // If we do NOT have an SSH private key, we must have the decrypted password
      if (!privateKey) {
        throw new SshError(
          "no_credentials",
          vaultErr.message || "Vault is locked. Unlock the vault or add an SSH key to access this server."
        );
      }
      // If privateKey exists, we can still authenticate over SSH using the key!
    }
  }

  if (!password && !privateKey) {
    throw new SshError(
      "no_credentials",
      "Server has no usable SSH credentials. Add a server password or SSH private key.",
    );
  }

  const target: SshTarget = {
    id: server.id,
    hostname: server.hostname,
    ip: server.ip,
    username: server.username,
    sshPort: server.sshPort,
  };

  const connectHost = resolveTargetHost(server.ip);

  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const settleReject = (err: SshError) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    };

    const connectOptions: any = {
      host: connectHost,
      port: server.sshPort,
      username: server.username,
      readyTimeout: env.SSH_CONNECT_TIMEOUT_MS,
      hostVerifier: () => true,
    };

    // If privateKey exists, prioritize key authentication; else use password
    if (privateKey) {
      connectOptions.privateKey = privateKey;
    } else if (password) {
      connectOptions.password = password;
    }

    client
      .on("ready", () => {
        if (settled) return;
        settled = true;
        resolve({ client, target, password });
      })
      .on("error", (err: Error & { level?: string }) => {
        const kind: SshErrorKind =
          err.level === "client-authentication" ? "auth_failed" : "unreachable";
        settleReject(new SshError(kind, err.message));
      })
      .connect(connectOptions);
  });
}

/** Map an SshError to an HTTP status + client-safe message. */
export function sshErrorToHttp(err: unknown): { status: 404 | 409 | 503; message: string } {
  if (err instanceof SshError) {
    switch (err.kind) {
      case "not_found":
        return { status: 404, message: "Server not found" };
      case "no_credentials":
        return { status: 409, message: err.message || "Server has no usable SSH credentials" };
      case "auth_failed":
        return { status: 503, message: "SSH authentication failed" };
      case "unreachable":
        return { status: 503, message: "Server is unreachable over SSH" };
    }
  }
  const msg = (err as any)?.message || "SSH connection failed";
  return { status: 503, message: msg };
}
