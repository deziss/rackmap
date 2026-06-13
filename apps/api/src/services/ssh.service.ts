import { Client } from "ssh2";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { decryptSecret } from "../lib/crypto.js";

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
 * Open an authenticated ssh2 Client to a server using its stored, encrypted
 * credentials. The decrypted password never leaves this process. Caller owns
 * the returned client and MUST call `.end()` when done.
 *
 * Host-key policy is `accept-any` for internal LAN (TOFU pinning is a documented
 * follow-up). Throws a typed {@link SshError} on any failure.
 */
export async function connectToServer(serverId: number): Promise<{ client: Client; target: SshTarget }> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, hostname: true, ip: true, username: true, sshPort: true, passwordEnc: true, deletedAt: true },
  });
  if (!server || server.deletedAt) throw new SshError("not_found", "Server not found");
  if (!server.passwordEnc) throw new SshError("no_credentials", "Server has no stored password");

  const password = decryptSecret(server.passwordEnc);
  if (password === null) throw new SshError("no_credentials", "Could not decrypt stored password");

  const target: SshTarget = {
    id: server.id,
    hostname: server.hostname,
    ip: server.ip,
    username: server.username,
    sshPort: server.sshPort,
  };

  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const settleReject = (err: SshError) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    };

    client
      .on("ready", () => {
        if (settled) return;
        settled = true;
        resolve({ client, target });
      })
      .on("error", (err: Error & { level?: string }) => {
        // ssh2 surfaces auth failures with level "client-authentication"
        const kind: SshErrorKind =
          err.level === "client-authentication" ? "auth_failed" : "unreachable";
        settleReject(new SshError(kind, err.message));
      })
      .connect({
        host: server.ip,
        port: server.sshPort,
        username: server.username,
        password,
        readyTimeout: env.SSH_CONNECT_TIMEOUT_MS,
        // accept-any host key for internal LAN; TOFU pinning = future
        hostVerifier: () => true,
      });
  });
}

/** Map an SshError to an HTTP status + client-safe message. */
export function sshErrorToHttp(err: unknown): { status: 404 | 409 | 503; message: string } {
  if (err instanceof SshError) {
    switch (err.kind) {
      case "not_found":
        return { status: 404, message: "Server not found" };
      case "no_credentials":
        return { status: 409, message: "Server has no usable SSH credentials" };
      case "auth_failed":
        return { status: 503, message: "SSH authentication failed" };
      case "unreachable":
        return { status: 503, message: "Server is unreachable over SSH" };
    }
  }
  return { status: 503, message: "SSH connection failed" };
}
