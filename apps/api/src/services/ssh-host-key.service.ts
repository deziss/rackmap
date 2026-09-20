import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { env } from "../env.js";

/**
 * SSH host-key verification (trust-on-first-use).
 *
 * Every outbound SSH connection in this codebase goes through
 * `connectToServer()` in ./ssh.service.ts, which used to pass
 * `hostVerifier: () => true` — i.e. every host key from every endpoint was
 * accepted unconditionally. That matters more here than in a generic SSH client
 * because the auth chain falls back to `keyboard-interactive` and answers EVERY
 * prompt with the decrypted server password, so a spoofed host can harvest the
 * plaintext password as many times as it cares to ask. The destination itself is
 * DB-controlled (`resolveTargetHost(server.ip)`), so anyone who can edit a
 * server's `ip` could previously redirect those credentials anywhere.
 *
 * Host keys are pinned per (host, port) endpoint, never per server row — see the
 * `SshHostKey` model comment in prisma/schema.prisma for why.
 */

export type HostKeyPolicy = "accept-any" | "tofu";

export type HostKeyDecision =
  /** No key pinned for this endpoint yet: recorded and accepted. */
  | "first_seen"
  /** Presented key matches the pinned key. */
  | "match"
  /** Presented key differs from the pinned key. */
  | "mismatch"
  /** The store could not be consulted (DB error). */
  | "error";

export interface HostKeyVerdict {
  accepted: boolean;
  decision: HostKeyDecision;
  policy: HostKeyPolicy;
  host: string;
  port: number;
  /** Algorithm of the key the remote end just presented. */
  keyType: string;
  /** OpenSSH SHA-256 fingerprint of the key the remote end just presented. */
  fingerprint: string;
  /** Fingerprint currently pinned for this endpoint, when one exists. */
  knownFingerprint?: string;
  knownKeyType?: string;
  knownFirstSeenAt?: Date;
  /** Operator-facing explanation. Always set for "mismatch" and "error". */
  message?: string;
}

/**
 * OpenSSH-style SHA-256 fingerprint of a raw public key blob.
 * Identical to the `SHA256:...` form printed by `ssh-keygen -lf`, so an operator
 * can compare it against the host without any conversion.
 */
export function sshFingerprint(keyBlob: Buffer): string {
  const b64 = createHash("sha256").update(keyBlob).digest("base64");
  return `SHA256:${b64.replace(/=+$/, "")}`;
}

/**
 * Read the algorithm name out of an SSH public key blob.
 * Wire format is `uint32 length || name || <algorithm-specific fields>`.
 * Returns "unknown" rather than throwing on anything malformed — an unparseable
 * blob still gets a fingerprint and is still pinned/compared byte-for-byte.
 */
export function sshKeyType(keyBlob: Buffer): string {
  if (keyBlob.length < 4) return "unknown";
  const len = keyBlob.readUInt32BE(0);
  if (len <= 0 || len > 64 || keyBlob.length < 4 + len) return "unknown";
  const name = keyBlob.subarray(4, 4 + len).toString("ascii");
  return /^[\x21-\x7e]+$/.test(name) ? name : "unknown";
}

/** Normalize an endpoint address so "10.0.0.5" and "10.0.0.5 " pin the same row. */
export function normalizeHost(host: string): string {
  return (host ?? "").trim().toLowerCase();
}

/** Human-readable "host:port" for log lines and error messages. */
export function endpointLabel(host: string, port: number): string {
  return `${normalizeHost(host)}:${port}`;
}

export interface VerifyHostKeyArgs {
  host: string;
  port: number;
  /** The raw public key blob exactly as ssh2 handed it to `hostVerifier`. */
  keyBlob: Buffer;
  /** Best-effort back-reference for operator review; not part of the trust key. */
  serverId?: number | null;
  /** Defaults to `env.SSH_HOST_POLICY`. */
  policy?: HostKeyPolicy;
}

function mismatchMessage(v: {
  host: string;
  port: number;
  fingerprint: string;
  keyType: string;
  knownFingerprint: string;
  knownKeyType: string;
  knownFirstSeenAt: Date;
  policy: HostKeyPolicy;
}): string {
  const where = endpointLabel(v.host, v.port);
  const action =
    v.policy === "tofu"
      ? "Connection REFUSED (SSH_HOST_POLICY=tofu)."
      : "Connection ALLOWED anyway because SSH_HOST_POLICY=accept-any — switch to tofu to refuse it.";
  return (
    `SSH HOST KEY CHANGED for ${where}. ` +
    `Pinned key was ${v.knownFingerprint} (${v.knownKeyType}, first seen ${v.knownFirstSeenAt.toISOString()}); ` +
    `the host now presented ${v.fingerprint} (${v.keyType}). ` +
    `This is either a rebuilt/reimaged host or a machine-in-the-middle intercepting credentials. ` +
    `${action} ` +
    `If the change is expected, delete the ssh_host_key row for ${where} so the next connection re-pins it.`
  );
}

/**
 * Compare the presented host key against the pinned one, recording it on first
 * sight. Never throws: a store failure becomes a verdict with decision "error"
 * so the caller always gets an explicit accept/refuse answer.
 */
export async function verifyHostKey(args: VerifyHostKeyArgs): Promise<HostKeyVerdict> {
  const policy: HostKeyPolicy = args.policy ?? env.SSH_HOST_POLICY;
  const host = normalizeHost(args.host);
  const port = args.port;
  const fingerprint = sshFingerprint(args.keyBlob);
  const keyType = sshKeyType(args.keyBlob);
  const publicKey = args.keyBlob.toString("base64");
  const serverId = args.serverId ?? null;
  const base = { policy, host, port, keyType, fingerprint } as const;

  try {
    const known = await prisma.sshHostKey.findUnique({ where: { host_port: { host, port } } });

    if (!known) {
      // Trust on first use: pin it. A concurrent connection to the same endpoint
      // can win the race, so a unique-constraint violation is not an error — we
      // re-read and compare against whatever landed first.
      try {
        const created = await prisma.sshHostKey.create({
          data: { host, port, keyType, fingerprint, publicKey, serverId },
        });
        console.warn(
          `[ssh-host-key] FIRST SIGHTING pinned for ${endpointLabel(host, port)}: ` +
            `${fingerprint} (${keyType})${serverId !== null ? ` [server #${serverId}]` : ""}. ` +
            `Verify it against the host with \`ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub\` before trusting it.`,
        );
        return {
          ...base,
          accepted: true,
          decision: "first_seen",
          knownFirstSeenAt: created.firstSeenAt,
          message: `First sighting pinned for ${endpointLabel(host, port)}.`,
        };
      } catch (createErr) {
        const raced = await prisma.sshHostKey.findUnique({ where: { host_port: { host, port } } });
        if (!raced) throw createErr;
        return compareKnown(raced, { ...base, publicKey, serverId });
      }
    }

    return compareKnown(known, { ...base, publicKey, serverId });
  } catch (err) {
    // The store could not be consulted. Under "tofu" that is fail-closed: we
    // cannot assert the endpoint is the one we pinned, so we refuse rather than
    // hand a password to an unverified host. Under "accept-any" the documented
    // contract is "never refuse", so we accept — loudly.
    const message =
      `SSH host-key store unavailable for ${endpointLabel(host, port)} ` +
      `(${(err as Error)?.message ?? String(err)}). ` +
      (policy === "tofu"
        ? "Refusing the connection (SSH_HOST_POLICY=tofu fails closed)."
        : "Accepting unverified (SSH_HOST_POLICY=accept-any).");
    console.error(`[ssh-host-key] ${message}`);
    return { ...base, accepted: policy !== "tofu", decision: "error", message };
  }
}

type KnownRow = {
  fingerprint: string;
  keyType: string;
  firstSeenAt: Date;
  serverId: number | null;
};

async function compareKnown(
  known: KnownRow,
  ctx: {
    policy: HostKeyPolicy;
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
    publicKey: string;
    serverId: number | null;
  },
): Promise<HostKeyVerdict> {
  const { policy, host, port, keyType, fingerprint } = ctx;
  const base = { policy, host, port, keyType, fingerprint } as const;

  if (known.fingerprint === fingerprint) {
    // Refresh liveness + the best-effort server back-reference. Deliberately does
    // not rewrite keyType/publicKey: the pinned bytes are the trust anchor.
    await prisma.sshHostKey
      .update({
        where: { host_port: { host, port } },
        data: { lastSeenAt: new Date(), ...(ctx.serverId !== null ? { serverId: ctx.serverId } : {}) },
      })
      .catch(() => {
        /* liveness bookkeeping only — never fail a verified connection on it */
      });
    return {
      ...base,
      accepted: true,
      decision: "match",
      knownFingerprint: known.fingerprint,
      knownKeyType: known.keyType,
      knownFirstSeenAt: known.firstSeenAt,
    };
  }

  // MISMATCH. The pinned row is left completely untouched — not even lastSeenAt.
  // Self-healing the store here would erase exactly the evidence an operator
  // needs, and would make "accept-any" hide the attack it is meant to surface.
  const message = mismatchMessage({
    host,
    port,
    fingerprint,
    keyType,
    knownFingerprint: known.fingerprint,
    knownKeyType: known.keyType,
    knownFirstSeenAt: known.firstSeenAt,
    policy,
  });
  console.error(`[ssh-host-key] ${message}`);
  return {
    ...base,
    accepted: policy !== "tofu",
    decision: "mismatch",
    knownFingerprint: known.fingerprint,
    knownKeyType: known.keyType,
    knownFirstSeenAt: known.firstSeenAt,
    message,
  };
}

/**
 * Build the `hostVerifier` callback for ssh2's `ConnectConfig`.
 *
 * ssh2 supports both a synchronous verifier (returns a boolean) and an async one
 * (returns `undefined`, answers later through the `verify` callback) — see
 * ssh2/lib/protocol/kex.js, which treats an `undefined` return as "async host
 * verification" and suspends the key exchange until `verify()` fires. Our check
 * hits the database, so we MUST take the async branch: the returned function is
 * intentionally NOT `async` (an async function returns a Promise, which ssh2
 * would coerce to a truthy "accepted" answer and let every connection through).
 * It returns `undefined` synchronously, never blocks the event loop, and no data
 * flows until `verify()` is called with a real answer.
 */
export function createHostVerifier(opts: {
  host: string;
  port: number;
  serverId?: number | null;
  policy?: HostKeyPolicy;
  /** Invoked exactly once with the verdict, before `verify()` is answered. */
  onVerdict?: (verdict: HostKeyVerdict) => void;
}): (keyBlob: Buffer, verify: (valid: boolean) => void) => void {
  return (keyBlob, verify) => {
    let answered = false;
    const answer = (valid: boolean) => {
      if (answered) return;
      answered = true;
      try {
        verify(valid);
      } catch {
        /* socket already torn down */
      }
    };

    void verifyHostKey({
      host: opts.host,
      port: opts.port,
      keyBlob,
      serverId: opts.serverId ?? null,
      policy: opts.policy,
    }).then(
      (verdict) => {
        try {
          opts.onVerdict?.(verdict);
        } catch {
          /* never let a listener decide the handshake */
        }
        answer(verdict.accepted);
      },
      (err) => {
        // verifyHostKey is written not to reject; this is belt-and-braces.
        console.error(
          `[ssh-host-key] verifier crashed for ${endpointLabel(opts.host, opts.port)}: ${(err as Error)?.message ?? err}`,
        );
        answer((opts.policy ?? env.SSH_HOST_POLICY) !== "tofu");
      },
    );

    // Returning undefined puts ssh2 into async host-verification mode. Do not
    // change this to an expression-bodied arrow or an async function.
    return undefined;
  };
}
