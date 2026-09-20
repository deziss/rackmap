import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { prisma } from "../db.js";
import {
  createHostVerifier,
  normalizeHost,
  sshFingerprint,
  sshKeyType,
  verifyHostKey,
  type HostKeyVerdict,
} from "../services/ssh-host-key.service.js";

/**
 * Build a well-formed SSH public key blob: `uint32 len || alg || uint32 len || payload`.
 * That is the exact shape ssh2 hands to `hostVerifier` (we never set `hostHash`, so the
 * blob arrives raw rather than pre-hashed).
 */
function keyBlob(alg: string, payload: Buffer): Buffer {
  const name = Buffer.from(alg, "ascii");
  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32BE(name.length, 0);
  const payloadLen = Buffer.alloc(4);
  payloadLen.writeUInt32BE(payload.length, 0);
  return Buffer.concat([nameLen, name, payloadLen, payload]);
}

const ED25519_A = keyBlob("ssh-ed25519", Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
const ED25519_B = keyBlob("ssh-ed25519", Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i)));
const RSA_A = keyBlob("ssh-rsa", Buffer.from(Array.from({ length: 64 }, (_, i) => i * 3)));

// Verified byte-for-byte against `ssh-keygen -lf` for this exact blob.
const ED25519_A_FINGERPRINT = "SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA";

const HOST = "10.77.0.5";
const PORT = 22;

describe("ssh-host-key.service", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await prisma.sshHostKey.deleteMany();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("fingerprinting", () => {
    it("produces the same SHA-256 fingerprint OpenSSH prints", () => {
      // `ssh-keygen -lf` on this blob prints exactly this string, unpadded base64.
      expect(sshFingerprint(ED25519_A)).toBe(ED25519_A_FINGERPRINT);
      expect(sshFingerprint(ED25519_A)).not.toContain("=");
    });

    it("gives different keys different fingerprints", () => {
      expect(sshFingerprint(ED25519_A)).not.toBe(sshFingerprint(ED25519_B));
    });

    it("reads the algorithm name out of the key blob", () => {
      expect(sshKeyType(ED25519_A)).toBe("ssh-ed25519");
      expect(sshKeyType(RSA_A)).toBe("ssh-rsa");
    });

    it("does not throw on malformed blobs", () => {
      expect(sshKeyType(Buffer.alloc(0))).toBe("unknown");
      expect(sshKeyType(Buffer.from([0x00, 0x01]))).toBe("unknown");
      expect(sshKeyType(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]))).toBe("unknown");
      // A blob we cannot parse is still pinnable: it gets a real fingerprint.
      expect(sshFingerprint(Buffer.from([0x00, 0x01]))).toMatch(/^SHA256:/);
    });

    it("normalizes endpoint hosts so trailing space / case pin one row", () => {
      expect(normalizeHost("  10.0.0.5 ")).toBe("10.0.0.5");
      expect(normalizeHost("Server.Example.COM")).toBe("server.example.com");
    });
  });

  describe("first sighting", () => {
    it("records the key and accepts under tofu", async () => {
      const verdict = await verifyHostKey({
        host: HOST,
        port: PORT,
        keyBlob: ED25519_A,
        serverId: 42,
        policy: "tofu",
      });

      expect(verdict.accepted).toBe(true);
      expect(verdict.decision).toBe("first_seen");
      expect(verdict.fingerprint).toBe(ED25519_A_FINGERPRINT);
      expect(verdict.keyType).toBe("ssh-ed25519");

      const row = await prisma.sshHostKey.findUnique({ where: { host_port: { host: HOST, port: PORT } } });
      expect(row).not.toBeNull();
      expect(row!.fingerprint).toBe(ED25519_A_FINGERPRINT);
      expect(row!.keyType).toBe("ssh-ed25519");
      expect(row!.publicKey).toBe(ED25519_A.toString("base64"));
      expect(row!.serverId).toBe(42);
      expect(row!.firstSeenAt).toBeInstanceOf(Date);
      expect(row!.lastSeenAt).toBeInstanceOf(Date);
    });

    it("records the key and accepts under accept-any too", async () => {
      const verdict = await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_A, policy: "accept-any" });

      expect(verdict.accepted).toBe(true);
      expect(verdict.decision).toBe("first_seen");
      expect(await prisma.sshHostKey.count()).toBe(1);
      // accept-any is not silent: a first sighting is announced so operators can review it.
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("FIRST SIGHTING");
    });

    it("pins per (host, port) endpoint, not per server", async () => {
      await verifyHostKey({ host: HOST, port: 22, keyBlob: ED25519_A, serverId: 1, policy: "tofu" });
      // Same address, different port is a different endpoint and pins independently.
      const other = await verifyHostKey({ host: HOST, port: 2222, keyBlob: ED25519_B, serverId: 1, policy: "tofu" });
      expect(other.decision).toBe("first_seen");
      expect(await prisma.sshHostKey.count()).toBe(2);

      // A DIFFERENT server row pointed at an already-pinned endpoint is compared
      // against that endpoint's key — editing `ip` cannot inherit another host's trust.
      const reused = await verifyHostKey({ host: HOST, port: 22, keyBlob: ED25519_B, serverId: 999, policy: "tofu" });
      expect(reused.decision).toBe("mismatch");
      expect(reused.accepted).toBe(false);
    });
  });

  describe("reconnect with a matching key", () => {
    it("accepts and refreshes lastSeenAt without duplicating the row", async () => {
      const first = await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_A, serverId: 7, policy: "tofu" });
      expect(first.decision).toBe("first_seen");

      const before = await prisma.sshHostKey.findUnique({ where: { host_port: { host: HOST, port: PORT } } });
      // Backdate so the refresh is observable regardless of clock resolution.
      await prisma.sshHostKey.update({
        where: { host_port: { host: HOST, port: PORT } },
        data: { lastSeenAt: new Date(Date.now() - 60_000) },
      });

      const second = await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_A, serverId: 7, policy: "tofu" });
      expect(second.accepted).toBe(true);
      expect(second.decision).toBe("match");
      expect(second.knownFingerprint).toBe(ED25519_A_FINGERPRINT);

      expect(await prisma.sshHostKey.count()).toBe(1);
      const after = await prisma.sshHostKey.findUnique({ where: { host_port: { host: HOST, port: PORT } } });
      expect(after!.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      // The TOFU moment itself never moves.
      expect(after!.firstSeenAt.getTime()).toBe(before!.firstSeenAt.getTime());
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("matches a host recorded with different spacing/casing", async () => {
      await verifyHostKey({ host: "  Server.Example.COM ", port: PORT, keyBlob: ED25519_A, policy: "tofu" });
      const again = await verifyHostKey({ host: "server.example.com", port: PORT, keyBlob: ED25519_A, policy: "tofu" });
      expect(again.decision).toBe("match");
      expect(await prisma.sshHostKey.count()).toBe(1);
    });
  });

  describe("changed key", () => {
    beforeEach(async () => {
      await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_A, serverId: 3, policy: "tofu" });
      warnSpy.mockClear();
      errorSpy.mockClear();
    });

    it("is REJECTED under tofu, naming both fingerprints", async () => {
      const verdict = await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_B, serverId: 3, policy: "tofu" });

      expect(verdict.accepted).toBe(false);
      expect(verdict.decision).toBe("mismatch");
      expect(verdict.knownFingerprint).toBe(ED25519_A_FINGERPRINT);
      expect(verdict.fingerprint).toBe(sshFingerprint(ED25519_B));
      expect(verdict.message).toContain("SSH HOST KEY CHANGED");
      expect(verdict.message).toContain(`${HOST}:${PORT}`);
      expect(verdict.message).toContain(ED25519_A_FINGERPRINT);
      expect(verdict.message).toContain(sshFingerprint(ED25519_B));
      expect(verdict.message).toContain("REFUSED");
      expect(errorSpy).toHaveBeenCalled();
    });

    it("WARNS but accepts under accept-any", async () => {
      const verdict = await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_B, serverId: 3, policy: "accept-any" });

      expect(verdict.accepted).toBe(true);
      expect(verdict.decision).toBe("mismatch");
      expect(verdict.knownFingerprint).toBe(ED25519_A_FINGERPRINT);
      expect(verdict.message).toContain("SSH HOST KEY CHANGED");
      expect(verdict.message).toContain("ALLOWED anyway");
      expect(verdict.message).toContain("switch to tofu");
      // Loud: it goes to console.error, not console.log.
      expect(errorSpy).toHaveBeenCalled();
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("SSH HOST KEY CHANGED");
    });

    it("never self-heals the pinned row, under either policy", async () => {
      const before = await prisma.sshHostKey.findUnique({ where: { host_port: { host: HOST, port: PORT } } });

      await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_B, policy: "accept-any" });
      await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_B, policy: "tofu" });

      const after = await prisma.sshHostKey.findUnique({ where: { host_port: { host: HOST, port: PORT } } });
      expect(await prisma.sshHostKey.count()).toBe(1);
      expect(after!.fingerprint).toBe(before!.fingerprint);
      expect(after!.publicKey).toBe(before!.publicKey);
      // Not even lastSeenAt moves — a mismatch must leave the evidence untouched.
      expect(after!.lastSeenAt.getTime()).toBe(before!.lastSeenAt.getTime());
    });

    it("re-pins after the operator deletes the row (documented rebuild path)", async () => {
      await prisma.sshHostKey.delete({ where: { host_port: { host: HOST, port: PORT } } });
      const verdict = await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_B, policy: "tofu" });
      expect(verdict.decision).toBe("first_seen");
      expect(verdict.accepted).toBe(true);
    });
  });

  describe("createHostVerifier (ssh2 contract)", () => {
    it("returns undefined synchronously so ssh2 takes the async branch", async () => {
      const verifier = createHostVerifier({ host: HOST, port: PORT, policy: "tofu" });
      let returned: unknown = "not-called";
      // ssh2 (lib/protocol/kex.js) treats ANY non-undefined return as an immediate
      // verdict. An `async` verifier would return a Promise — truthy — and let every
      // host through, so this must stay undefined. The callback is awaited so the
      // pending store write cannot leak into the next test.
      await new Promise<void>((resolve) => {
        returned = verifier(ED25519_A, () => resolve());
      });
      expect(returned).toBeUndefined();
    });

    it("accepts a first sighting via the callback", async () => {
      const verdicts: HostKeyVerdict[] = [];
      const verifier = createHostVerifier({
        host: HOST,
        port: PORT,
        serverId: 5,
        policy: "tofu",
        onVerdict: (v) => verdicts.push(v),
      });

      const permitted = await new Promise<boolean>((resolve) => verifier(ED25519_A, resolve));
      expect(permitted).toBe(true);
      expect(verdicts[0]?.decision).toBe("first_seen");
      expect(await prisma.sshHostKey.count()).toBe(1);
    });

    it("answers false for a changed key under tofu and reports the verdict", async () => {
      await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_A, policy: "tofu" });

      const verdicts: HostKeyVerdict[] = [];
      const verifier = createHostVerifier({
        host: HOST,
        port: PORT,
        policy: "tofu",
        onVerdict: (v) => verdicts.push(v),
      });

      const permitted = await new Promise<boolean>((resolve) => verifier(ED25519_B, resolve));
      expect(permitted).toBe(false);
      expect(verdicts[0]?.decision).toBe("mismatch");
      expect(verdicts[0]?.message).toContain("SSH HOST KEY CHANGED");
    });

    it("answers true for a changed key under accept-any", async () => {
      await verifyHostKey({ host: HOST, port: PORT, keyBlob: ED25519_A, policy: "accept-any" });
      const verifier = createHostVerifier({ host: HOST, port: PORT, policy: "accept-any" });
      const permitted = await new Promise<boolean>((resolve) => verifier(ED25519_B, resolve));
      expect(permitted).toBe(true);
    });

    it("answers exactly once even if ssh2 is called back twice", async () => {
      const verifier = createHostVerifier({ host: HOST, port: PORT, policy: "tofu" });
      const answers: boolean[] = [];
      await new Promise<void>((done) => {
        verifier(ED25519_A, (valid) => {
          answers.push(valid);
          // Second invocation is swallowed by the `answered` latch.
          setTimeout(done, 0);
        });
      });
      expect(answers).toEqual([true]);
    });
  });
});
