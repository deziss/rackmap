import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

export interface ConnectOptions {
  overridePassword?: string;
  preferredAuth?: "auto" | "key" | "password";
  keyId?: string;
}

/**
 * Builds a sudo-elevated command string.
 * If password is provided, uses `echo <password> | sudo -S -p '' <cmd>`
 * Otherwise falls back to passwordless `sudo -n <cmd> 2>/dev/null || <cmd>`.
 */
/**
 * Wrap a command so it runs under sudo, piping in the password when one is known.
 *
 * SECURITY: `cmd` is interpolated verbatim. Callers are responsible for escaping
 * every request-derived value inside it — use `escapeShellArg` from
 * ./shell-escape.js, or a stricter format-specific validator. Do not pass a
 * string built by concatenating unvalidated input.
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
 * 1. If preferredAuth === 'password' or overridePassword: use password directly.
 * 2. If preferredAuth === 'key': use SSH private keys only.
 * 3. Default ('auto'): attempt SSH key first. If rejected by remote server,
 *    automatically and seamlessly fallback to password and keyboard-interactive PAM authentication!
 */
export async function connectToServer(
  serverId: number,
  overridePasswordOrOptions?: string | ConnectOptions,
): Promise<{ client: Client; target: SshTarget; password?: string; authMethodUsed?: "key" | "password" }> {
  const opts: ConnectOptions =
    typeof overridePasswordOrOptions === "string"
      ? { overridePassword: overridePasswordOrOptions, preferredAuth: "password" }
      : overridePasswordOrOptions || {};

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, hostname: true, ip: true, username: true, sshPort: true, passwordEnc: true, deletedAt: true },
  });
  if (!server || server.deletedAt) throw new SshError("not_found", "Server not found");

  let password: string | undefined;
  let privateKey: string | Buffer | undefined;

  // 1. Search for available SSH private keys on host or storage
  const keyCandidates: string[] = [
    env.SSH_PRIVATE_KEY_PATH,
    "/data/id_ed25519",
    "/data/id_rsa",
    "/root/.ssh/id_ed25519",
    "/root/.ssh/id_rsa",
    // Home directory of whichever user the API runs as — resolved at runtime, never baked in.
    path.join(os.homedir(), ".ssh", "id_ed25519"),
    path.join(os.homedir(), ".ssh", "id_rsa"),
  ].filter(Boolean) as string[];

  // Include any custom uploaded keys in /data/ssh_keys
  try {
    if (fs.existsSync("/data/ssh_keys")) {
      const customFiles = fs.readdirSync("/data/ssh_keys");
      for (const f of customFiles) {
        if (f.endsWith(".pem") || f.endsWith(".key")) {
          keyCandidates.push(path.join("/data/ssh_keys", f));
        }
      }
    }
  } catch {
    // ignore dir read error
  }

  // If specific key requested
  if (opts.keyId) {
    const cleanId = opts.keyId.replace(/^(host:|custom:)/, "");
    for (const kp of keyCandidates) {
      if (kp.includes(cleanId) && fs.existsSync(kp)) {
        try {
          privateKey = fs.readFileSync(kp);
          break;
        } catch {
          // ignore
        }
      }
    }
  } else {
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
  }

  // 2. Resolve password (override or decrypted from Vault)
  if (opts.overridePassword !== undefined && opts.overridePassword !== "") {
    password = opts.overridePassword;
  } else if (server.passwordEnc) {
    try {
      const decrypted = await decryptPasswordWithVault(server.passwordEnc);
      if (decrypted !== null) {
        password = decrypted;
      }
    } catch (vaultErr: any) {
      // If we do NOT have an SSH private key, we must have the decrypted password
      if (!privateKey || opts.preferredAuth === "password") {
        throw new SshError(
          "no_credentials",
          vaultErr.message || "Vault is locked. Unlock the vault or enter server SSH password."
        );
      }
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
    let authMethodUsed: "key" | "password" = "key";

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

    // Determine authentication strategy
    const preferPass = opts.preferredAuth === "password" || (!!opts.overridePassword && !opts.keyId);
    const preferKey = opts.preferredAuth === "key";

    if (preferPass) {
      if (!password) {
        settleReject(new SshError("no_credentials", "Password authentication requested but no password provided."));
        return;
      }
      authMethodUsed = "password";
      connectOptions.password = password;
      connectOptions.tryKeyboard = true;
      connectOptions.authHandler = ["password", "keyboard-interactive"];
    } else if (preferKey) {
      if (!privateKey) {
        settleReject(new SshError("no_credentials", "SSH Key authentication requested but no private key found."));
        return;
      }
      authMethodUsed = "key";
      connectOptions.privateKey = privateKey;
      connectOptions.authHandler = ["publickey"];
    } else {
      // Auto mode: support both privateKey and password fallback
      if (privateKey) {
        connectOptions.privateKey = privateKey;
      }
      if (password) {
        connectOptions.password = password;
        connectOptions.tryKeyboard = true;
      }

      if (privateKey && password) {
        connectOptions.authHandler = ["publickey", "password", "keyboard-interactive"];
      } else if (privateKey) {
        authMethodUsed = "key";
        connectOptions.authHandler = ["publickey"];
      } else if (password) {
        authMethodUsed = "password";
        connectOptions.authHandler = ["password", "keyboard-interactive"];
      }
    }

    // Keyboard-interactive PAM fallback listener
    if (password) {
      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        authMethodUsed = "password";
        finish(prompts.map(() => password!));
      });
    }

    client
      .on("ready", () => {
        if (settled) return;
        settled = true;
        resolve({ client, target, password, authMethodUsed });
      })
      .on("error", (err: Error & { level?: string }) => {
        const kind: SshErrorKind =
          err.level === "client-authentication" ? "auth_failed" : "unreachable";
        const message =
          kind === "auth_failed"
            ? `SSH authentication failed for ${server.username}@${server.ip}:${server.sshPort} (Check SSH key and server password)`
            : err.message;
        settleReject(new SshError(kind, message));
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
        return { status: 503, message: err.message || "SSH authentication failed" };
      case "unreachable":
        return { status: 503, message: "Server is unreachable over SSH" };
    }
  }
  const msg = (err as any)?.message || "SSH connection failed";
  return { status: 503, message: msg };
}
