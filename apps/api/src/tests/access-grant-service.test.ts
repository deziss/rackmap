import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * access-grant.service against a fake host: connectToServer / execAsRoot and
 * the OS-user writes are mocked, so every generated script is captured and the
 * host's answer is scripted per test. The authorized_keys editor — the one
 * piece that edits a file on the host — is additionally run for real by `sh`
 * against a temporary directory.
 */

const mocks = vi.hoisted(() => ({
  execAsRoot: vi.fn(),
  connectToServer: vi.fn(),
  createOsUser: vi.fn(),
  deleteOsUser: vi.fn(),
}));

vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execAsRoot: mocks.execAsRoot };
});
vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});
vi.mock("../services/os-user.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/os-user.service.js")>();
  return { ...actual, createOsUser: mocks.createOsUser, deleteOsUser: mocks.deleteOsUser };
});
vi.mock("../services/alerting/emit.js", () => ({
  emitAlert: vi.fn(async (e: Record<string, unknown>) => {
    const { prisma } = await import("../db.js");
    const ev = await prisma.alertEvent.create({
      data: {
        type: e["type"] as string,
        severity: e["severity"] as string,
        action: (e["action"] as string) ?? "info",
        dedupKey: (e["dedupKey"] as string) ?? null,
        title: e["title"] as string,
        summary: e["summary"] as string,
        payload: (e["payload"] ?? {}) as object,
        serverId: (e["serverId"] as number) ?? null,
      },
    });
    return { eventId: ev.id, queued: 0 };
  }),
}));

const { prisma } = await import("../db.js");
const { escapeShellArg } = await import("../services/shell-escape.js");
const { SshError } = await import("../services/ssh.service.js");
const { PrivilegedTargetError } = await import("../services/os-user.service.js");
const svc = await import("../services/access-grant.service.js");
const { runAccessGrantSweep, retryDelayMs } = await import("../services/access-grant-sweeper.js");

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIaRzUDCUCz5Uanal7pq91W1zKAxtET/tL5dSBAEtoMm ops laptop:2026";
const KEY_FP = "SHA256:JaKrzpMNpT7kVtyxeO2AGh6iqco7T4Rd6Xxg4hRq+A0";
const HOUR = 3600_000;

function result(extra: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    durationMs: 5,
    ...extra,
  };
}

let scripts: string[] = [];
let host: (script: string) => ReturnType<typeof result> = () => result();
let serverId = 0;
let adminId = "";
let editorId = "";
let ctxAdmin: import("../services/access-grant.service.js").AccessGrantCtx;
let ctxEditor: import("../services/access-grant.service.js").AccessGrantCtx;

beforeAll(async () => {
  const server = await prisma.server.create({ data: { hostname: "grant-test.example.com", ip: "192.0.2.10", username: "ops" } });
  serverId = server.id;
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@inventory.local" } })).id;
  editorId = (await prisma.user.findUniqueOrThrow({ where: { email: "editor@inventory.local" } })).id;
  ctxAdmin = { actor: { id: adminId, role: "admin" }, audit: { actorId: adminId }, allowPrivileged: true };
  ctxEditor = { actor: { id: editorId, role: "editor" }, audit: { actorId: editorId }, allowPrivileged: false };
});

afterAll(async () => {
  await prisma.alertEvent.deleteMany({ where: { serverId } });
  await prisma.server.deleteMany({ where: { id: serverId } });
});

beforeEach(async () => {
  scripts = [];
  host = () => result();
  mocks.connectToServer.mockReset().mockResolvedValue({ client: { end: vi.fn() }, password: undefined });
  mocks.execAsRoot.mockReset().mockImplementation(async (_client: unknown, script: string) => {
    scripts.push(script);
    return host(script);
  });
  mocks.createOsUser.mockReset().mockResolvedValue({ ok: true, message: "created" });
  mocks.deleteOsUser.mockReset().mockResolvedValue({ ok: true, message: "deleted" });
  // Only this feature's tests use access_grant; start every test from an empty table
  // so the sweeper never picks up a row another test left behind.
  await prisma.accessGrant.deleteMany({});
  await prisma.alertEvent.deleteMany({ where: { serverId } });
});

const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

async function seedGrant(data: Record<string, unknown> = {}) {
  return prisma.accessGrant.create({
    data: {
      serverId,
      kind: "os_user",
      username: "tmpuser",
      onExpiry: "lock",
      reason: "test",
      expiresAt: new Date(Date.now() - 60_000),
      status: "active",
      createdById: adminId,
      ...data,
    },
  });
}

/** Remove every escapeShellArg'd literal; what is left is script structure only. */
function structureOf(script: string): string {
  return script.replace(/'(?:[^']|'\\'')*'/g, "''");
}

// ─── Expiry arithmetic ───────────────────────────────────────────────────────

describe("host-side expiry rounding", () => {
  it("chage day is the first UTC midnight at or after expiresAt (never early)", () => {
    const day = (iso: string) => svc.hostAccountExpiryDay(new Date(iso));
    expect(svc.hostAccountExpiryDate(new Date("2026-10-01T10:00:00Z"))).toBe("2026-10-02");
    expect(svc.hostAccountExpiryDate(new Date("2026-10-01T23:59:59Z"))).toBe("2026-10-02");
    expect(svc.hostAccountExpiryDate(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01");
    expect(day("2026-10-01T10:00:00Z") * 86_400_000).toBeGreaterThanOrEqual(Date.parse("2026-10-01T10:00:00Z"));
  });

  it("expiry-time rounds up to the minute", () => {
    expect(svc.keyExpiryEpoch(new Date("2026-10-01T10:00:00Z"))).toBe(Date.parse("2026-10-01T10:00:00Z") / 1000);
    expect(svc.keyExpiryEpoch(new Date("2026-10-01T10:00:01Z"))).toBe(Date.parse("2026-10-01T10:01:00Z") / 1000);
  });
});

// ─── Scripts ─────────────────────────────────────────────────────────────────

describe("generated scripts", () => {
  const all = () => [
    svc.buildKeyScript({ action: "add", username: "alice", grantId: 7, keyLine: KEY, expiresAt: new Date(), guard: true }),
    svc.buildKeyScript({ action: "add", username: "alice", grantId: 7, keyLine: KEY, expiresAt: new Date(), guard: false }),
    svc.buildKeyScript({ action: "update", username: "alice", grantId: 7, expiresAt: new Date(), guard: true }),
    svc.buildKeyScript({ action: "remove", username: "alice", grantId: 7, guard: false }),
    svc.buildLockAccountScript("alice"),
    svc.buildDeleteAccountScript("alice"),
    svc.buildAccountExpiryScript("alice", new Date(), { guard: true }),
  ];

  it("parse with sh -n", () => {
    for (const s of all()) execFileSync("sh", ["-n"], { input: s });
    execFileSync("sh", ["-n"], { input: svc.AUTHORIZED_KEYS_EDITOR });
  });

  it("carry the username, key and marker only as escapeShellArg literals", () => {
    const add = svc.buildKeyScript({ action: "add", username: "alice", grantId: 7, keyLine: KEY, expiresAt: new Date(), guard: true });
    expect(add).toContain(`u=${escapeShellArg("alice")}`);
    expect(add).toContain(escapeShellArg(`${KEY} rackmap-grant:7`));
    expect(add).toContain(escapeShellArg("rackmap-grant:7"));
    const bare = structureOf(add);
    expect(bare).not.toContain("alice");
    expect(bare).not.toContain("AAAAC3Nza");
    expect(bare).not.toContain("rackmap-grant:7");
    for (const s of all()) expect(structureOf(s)).not.toContain("alice");
  });

  it("guards privileged targets only when asked, and never while revoking", () => {
    const guarded = svc.buildKeyScript({ action: "add", username: "alice", grantId: 7, keyLine: KEY, expiresAt: new Date(), guard: true });
    expect(guarded).toContain("RACKMAP_PRIVILEGED_TARGET");
    expect(guarded).toMatch(/case "\$g" in sudo\|wheel\|admin\|docker/);
    expect(svc.buildKeyScript({ action: "add", username: "alice", grantId: 7, keyLine: KEY, guard: false })).not.toContain(
      "RACKMAP_PRIVILEGED_TARGET",
    );
    expect(svc.buildKeyScript({ action: "remove", username: "alice", grantId: 7, guard: true })).not.toContain(
      "RACKMAP_PRIVILEGED_TARGET",
    );
  });

  it("lock script locks, expires, drops the RackMap sudoers rule and kills sessions", () => {
    const s = svc.buildLockAccountScript("alice");
    expect(s).toContain('usermod -L "$u"');
    expect(s).toContain('chage -E 1 "$u"');
    expect(s).toContain(escapeShellArg("/etc/sudoers.d/rackmap_alice"));
    expect(s).toContain('pkill -KILL -u "$u"');
    expect(s).toMatch(/id -u "\$u"\)" = 0 \] && .*refusing/);
  });

  it("rejects a key line that spans lines", () => {
    expect(() =>
      svc.buildKeyScript({ action: "add", username: "alice", grantId: 7, keyLine: `${KEY}\nssh-ed25519 AAAA`, guard: false }),
    ).toThrow(/single line/);
  });
});

describe.skipIf(process.platform !== "linux")("authorized_keys editor (run for real)", () => {
  let home = "";
  const ak = () => join(home, ".ssh", "authorized_keys");
  const run = (...args: string[]) =>
    execFileSync("sh", ["-c", svc.AUTHORIZED_KEYS_EDITOR, "sh", ...args], { encoding: "utf8" });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rackmap-akhome-"));
  });
  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("creates ~/.ssh 0700 and authorized_keys 0600 and appends the line with expiry-time", () => {
    const out = run("add", home, "rackmap-grant:5", "202610011201", `${KEY} rackmap-grant:5`);
    expect(out).toContain("RACKMAP_GRANT_OK=0");
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(ak()).mode & 0o777).toBe(0o600);
    expect(readFileSync(ak(), "utf8")).toBe(`expiry-time="202610011201" ${KEY} rackmap-grant:5\n`);
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps other lines (and a missing final newline), updates and removes only its own marker", () => {
    mkdirSync(join(home, ".ssh"), { mode: 0o700 });
    const other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOth other@example.com";
    writeFileSync(ak(), `${other}\nexpiry-time="202601010000" ${KEY} rackmap-grant:12`);
    chmodSync(ak(), 0o640);

    run("add", home, "rackmap-grant:1", "202610011200", `${KEY} rackmap-grant:1`);
    let lines = readFileSync(ak(), "utf8").split("\n");
    expect(lines).toEqual([
      other,
      `expiry-time="202601010000" ${KEY} rackmap-grant:12`,
      `expiry-time="202610011200" ${KEY} rackmap-grant:1`,
      "",
    ]);
    expect(statSync(ak()).mode & 0o777).toBe(0o640); // mode preserved

    // A retried add replaces its own line instead of duplicating it.
    run("add", home, "rackmap-grant:1", "202610011200", `${KEY} rackmap-grant:1`);
    expect(readFileSync(ak(), "utf8").match(/rackmap-grant:1$/gm)).toHaveLength(1);

    run("update", home, "rackmap-grant:1", "202610081200", "");
    expect(readFileSync(ak(), "utf8")).toContain(`expiry-time="202610081200" ${KEY} rackmap-grant:1\n`);
    expect(readFileSync(ak(), "utf8")).toContain(`expiry-time="202601010000" ${KEY} rackmap-grant:12`);

    const removed = run("remove", home, "rackmap-grant:1", "", "");
    expect(removed).toContain("RACKMAP_GRANT_OK=1");
    lines = readFileSync(ak(), "utf8").split("\n");
    expect(lines).toEqual([other, `expiry-time="202601010000" ${KEY} rackmap-grant:12`, ""]);
    expect(statSync(ak()).mode & 0o777).toBe(0o640);

    // Nothing left to remove is success, and update of a missing line is exit 3.
    expect(run("remove", home, "rackmap-grant:1", "", "")).toContain("RACKMAP_GRANT_REMOVED=0");
    expect(() => run("update", home, "rackmap-grant:1", "202610081200", "")).toThrow();
    rmSync(home, { recursive: true, force: true });
  });

  it("remove on an account without ~/.ssh is a no-op success", () => {
    expect(run("remove", home, "rackmap-grant:9", "", "")).toContain("RACKMAP_GRANT_REMOVED=0");
    rmSync(home, { recursive: true, force: true });
  });
});

/**
 * Host scripts run by `sh` for real, with the account tools (id, chage, usermod,
 * getent, ssh, runuser, sudo) replaced by stubs in a temporary directory that
 * heads PATH; without `system`, PATH is that directory alone, so no real tool
 * can be reached.
 */
describe.skipIf(process.platform !== "linux")("host scripts against stub tools (run for real)", () => {
  let bin = "";
  let home = "";

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "rackmap-stubs-"));
    home = mkdtempSync(join(tmpdir(), "rackmap-akhome-"));
  });
  afterEach(() => {
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function runStubbed(script: string, tools: Record<string, string>, opts: { system?: boolean } = {}) {
    for (const [name, body] of Object.entries(tools)) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const lines = script.split("\n");
    expect(lines[0]).toMatch(/^PATH=.*; export PATH$/);
    lines[0] = `PATH=${bin}${opts.system ? ":/usr/bin:/bin" : ""}; export PATH`;
    const r = spawnSync("/bin/sh", ["-s"], { input: lines.join("\n"), encoding: "utf8" });
    return result({ exitCode: r.status, stdout: r.stdout, stderr: r.stderr });
  }

  const expiry = (u = "alice") => svc.buildAccountExpiryScript(u, new Date(Date.now() + 48 * HOUR), { guard: false });
  const CHAGE_FAILS = 'echo "chage: cannot lock /etc/shadow; try again later." >&2; exit 1';

  it("account expiry: a chage or usermod that fails exits non-zero instead of warning", () => {
    let r = runStubbed(expiry(), { id: "exit 0", chage: CHAGE_FAILS, usermod: "exit 0" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain("RACKMAP_WARN");

    rmSync(join(bin, "chage"));
    r = runStubbed(expiry(), { id: "exit 0", usermod: 'echo "usermod: user alice is currently used" >&2; exit 8' });
    expect(r.exitCode).toBe(8);
    expect(r.stdout).not.toContain("RACKMAP_WARN");
  });

  it("account expiry: chage succeeds silently; a host with neither tool only warns", () => {
    const day = String(svc.hostAccountExpiryDay(new Date(Date.now() + 48 * HOUR)));
    let r = runStubbed(expiry(), { id: "exit 0", chage: 'echo "$@" > "$0.args"' });
    expect(r).toMatchObject({ exitCode: 0, stdout: "" });
    expect(readFileSync(join(bin, "chage.args"), "utf8").trim()).toBe(`-E ${day} alice`);

    rmSync(join(bin, "chage"));
    r = runStubbed(expiry(), { id: "exit 0" });
    expect(r).toMatchObject({ exitCode: 0, stdout: "RACKMAP_WARN:account-expiry-unavailable\n" });
  });

  it("extendGrant: a failed chage fails the extension and leaves expiry and status untouched", async () => {
    const g = await seedGrant({ expiresAt: new Date(Date.now() + HOUR), createdById: editorId });
    const next = new Date(Date.now() + 48 * HOUR);
    host = (script) => runStubbed(script, { id: "exit 0", chage: CHAGE_FAILS });
    await expect(svc.extendGrant(g.id, next.toISOString(), ctxAdmin)).rejects.toThrow(/cannot lock \/etc\/shadow/);
    let row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.status).toBe("active");
    expect(row.expiresAt.toISOString()).toBe(g.expiresAt.toISOString());
    expect(await prisma.auditLog.count({ where: { action: "access_grant.extend", entityId: String(g.id) } })).toBe(0);

    // No chage/usermod at all: the host never had its own expiry, so this stays a warning.
    rmSync(join(bin, "chage"));
    host = (script) => runStubbed(script, { id: "exit 0" });
    const { grant, warnings } = await svc.extendGrant(g.id, next.toISOString(), ctxAdmin);
    expect(warnings).toEqual([expect.stringMatching(/chage\/usermod -e/)]);
    row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.expiresAt.toISOString()).toBe(next.toISOString());
    expect(grant.status).toBe("active");
  });

  it("createTemporaryUser still records the grant when chage fails, as a warning", async () => {
    host = (script) => runStubbed(script, { id: "exit 0", chage: CHAGE_FAILS });
    const { grant, warnings } = await svc.createTemporaryUser(
      { serverId, username: "c7", expiresAt: inHours(2), onExpiry: "lock", reason: "x" },
      ctxAdmin,
    );
    expect(grant.status).toBe("active");
    expect(warnings).toEqual([expect.stringMatching(/chage\/usermod -e.*cannot lock \/etc\/shadow/)]);
  });

  it("extendGrant: an sshd without expiry-time (OpenSSH < 8.2) still extends, with the warning", async () => {
    const g = await seedGrant({ kind: "ssh_key", username: "deploy", onExpiry: "remove", keyFingerprint: KEY_FP, expiresAt: new Date(Date.now() + HOUR) });
    mkdirSync(join(home, ".ssh"), { mode: 0o700 });
    writeFileSync(join(home, ".ssh", "authorized_keys"), `${KEY} rackmap-grant:${g.id}\n`, { mode: 0o600 });
    const tools = {
      id: '[ "$1" = -u ] && echo 1000; exit 0',
      getent: `echo "deploy:x:1000:1000::${home}:/bin/sh"`,
      ssh: 'echo "OpenSSH_7.4p1, OpenSSL 1.0.2k-fips  26 Jan 2017" >&2',
      runuser: 'shift 3; exec "$@"', // runuser -u "$u" -- sh -c "$editor" sh …
      sudo: "exit 1",
    };
    host = (script) => runStubbed(script, tools, { system: true });
    const next = new Date(Date.now() + 5 * HOUR);
    const { grant, warnings } = await svc.extendGrant(g.id, next.toISOString(), ctxAdmin);
    expect(warnings).toEqual([expect.stringMatching(/OpenSSH 8\.2/)]);
    expect(grant.expiresAt.toISOString()).toBe(next.toISOString());
    expect(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8")).toBe(`${KEY} rackmap-grant:${g.id}\n`);
  });
});

// ─── Create ──────────────────────────────────────────────────────────────────

describe("createTemporaryUser", () => {
  it("creates the account via createOsUser, sets chage -E, then records the grant", async () => {
    const expiresAt = inHours(8);
    const { grant, warnings } = await svc.createTemporaryUser(
      { serverId, username: "contractor1", expiresAt, onExpiry: "lock", reason: "INC-42 debugging", groups: ["developers"] },
      ctxEditor,
    );
    expect(warnings).toEqual([]);
    expect(mocks.createOsUser).toHaveBeenCalledTimes(1);
    const [sid, input, , , opts] = mocks.createOsUser.mock.calls[0]!;
    expect(sid).toBe(serverId);
    expect(input).toMatchObject({ username: "contractor1", groups: ["developers"], createHome: true });
    expect(opts).toEqual({ allowPrivileged: false });

    expect(scripts).toHaveLength(1);
    const day = svc.hostAccountExpiryDay(new Date(expiresAt));
    expect(scripts[0]).toContain(`chage -E ${escapeShellArg(String(day))} "$u"`);
    expect(scripts[0]).toContain(`u=${escapeShellArg("contractor1")}`);

    expect(grant).toMatchObject({ kind: "os_user", username: "contractor1", status: "active", onExpiry: "lock", createdById: editorId });
    const audit = await prisma.auditLog.findFirst({ where: { action: "access_grant.create", entityId: String(grant.id) } });
    expect(audit).not.toBeNull();
  });

  it("refuses a privileged group without server:sudo before touching the host", async () => {
    await expect(
      svc.createTemporaryUser({ serverId, username: "c2", expiresAt: inHours(1), onExpiry: "lock", reason: "x", groups: ["docker"] }, ctxEditor),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.createOsUser).not.toHaveBeenCalled();
    expect(scripts).toHaveLength(0);
  });

  it("passes allowPrivileged through for a caller with server:sudo", async () => {
    await svc.createTemporaryUser(
      { serverId, username: "c3", expiresAt: inHours(1), onExpiry: "delete", reason: "x", sudoType: "all_passwd" },
      ctxAdmin,
    );
    expect(mocks.createOsUser.mock.calls[0]![4]).toEqual({ allowPrivileged: true });
  });

  it("keeps the grant but warns when the host-side expiry cannot be set", async () => {
    host = () => result({ stdout: "RACKMAP_WARN:account-expiry-unavailable\n" });
    const { grant, warnings } = await svc.createTemporaryUser(
      { serverId, username: "c4", expiresAt: inHours(1), onExpiry: "lock", reason: "x" },
      ctxEditor,
    );
    expect(grant.status).toBe("active");
    expect(warnings).toHaveLength(1);
  });

  it("locks the new account again when the grant row cannot be written", async () => {
    const doomed = await prisma.server.create({ data: { hostname: "grant-doomed.example.com", ip: "192.0.2.11", username: "ops" } });
    // The server disappears between the host change and the insert → FK violation.
    mocks.createOsUser.mockImplementationOnce(async () => {
      await prisma.server.delete({ where: { id: doomed.id } });
      return { ok: true, message: "created" };
    });
    await expect(
      svc.createTemporaryUser({ serverId: doomed.id, username: "c5", expiresAt: inHours(1), onExpiry: "lock", reason: "x" }, ctxEditor),
    ).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/locked the account again/) });
    expect(scripts.some((s) => s.includes('usermod -L "$u"') && s.includes(escapeShellArg("c5")))).toBe(true);
  });

  it("rejects an expiry in the past or beyond 90 days", async () => {
    for (const expiresAt of [inHours(-1), inHours(24 * 91)]) {
      await expect(
        svc.createTemporaryUser({ serverId, username: "c6", expiresAt, onExpiry: "lock", reason: "x" }, ctxAdmin),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.createOsUser).not.toHaveBeenCalled();
  });
});

describe("grantTemporaryKey", () => {
  it("records the fingerprint and appends the key with its marker", async () => {
    const { grant } = await svc.grantTemporaryKey({ serverId, username: "deploy", publicKey: `${KEY}\n`, expiresAt: inHours(2), reason: "x" }, ctxEditor);
    expect(grant).toMatchObject({ kind: "ssh_key", keyFingerprint: KEY_FP, onExpiry: "remove", status: "active" });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(escapeShellArg(`${KEY} rackmap-grant:${grant.id}`));
    expect(scripts[0]).toContain(`${escapeShellArg("add")} "$home"`);
    expect(scripts[0]).toContain("runuser -u \"$u\"");
    expect(scripts[0]).toContain("RACKMAP_PRIVILEGED_TARGET"); // editor → guarded
  });

  it("maps the host's privileged-target refusal to PrivilegedTargetError and drops the row", async () => {
    host = () => result({ exitCode: 77, stderr: "RACKMAP_PRIVILEGED_TARGET\n" });
    await expect(
      svc.grantTemporaryKey({ serverId, username: "ubuntu", publicKey: KEY, expiresAt: inHours(2), reason: "x" }, ctxEditor),
    ).rejects.toBeInstanceOf(PrivilegedTargetError);
    expect(await prisma.accessGrant.count({ where: { serverId } })).toBe(0);
  });

  it("refuses root without server:sudo and an invalid key, before any SSH", async () => {
    await expect(
      svc.grantTemporaryKey({ serverId, username: "root", publicKey: KEY, expiresAt: inHours(2), reason: "x" }, ctxEditor),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      svc.grantTemporaryKey({ serverId, username: "deploy", publicKey: `command="id" ${KEY}`, expiresAt: inHours(2), reason: "x" }, ctxEditor),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it("an unknown outcome (timeout) keeps the row but expires it so the sweeper cleans up", async () => {
    host = () => result({ exitCode: null, timedOut: true, errorCode: "TIMEOUT", errorMessage: "timed out" });
    await expect(
      svc.grantTemporaryKey({ serverId, username: "deploy", publicKey: KEY, expiresAt: inHours(2), reason: "x" }, ctxEditor),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    const row = await prisma.accessGrant.findFirstOrThrow({ where: { serverId } });
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.lastError).toMatch(/not confirmed/);
  });
});

// ─── Revoke / sweeper ────────────────────────────────────────────────────────

describe("revokeGrant", () => {
  it("removes the key line by marker and marks the grant revoked", async () => {
    const g = await seedGrant({ kind: "ssh_key", username: "deploy", onExpiry: "remove", keyFingerprint: KEY_FP });
    host = () => result({ stdout: "RACKMAP_GRANT_OK=1\n" });
    const r = await svc.revokeGrant(g.id, { actor: null });
    expect(r.outcome).toBe("revoked");
    expect(scripts[0]).toContain(`${escapeShellArg("remove")} "$home" ${escapeShellArg(`rackmap-grant:${g.id}`)}`);
    const row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.status).toBe("revoked");
    expect(row.revokedAt).not.toBeNull();
    const events = await prisma.alertEvent.findMany({ where: { serverId, type: "access_expired" } });
    expect(events).toHaveLength(1);
  });

  it("delete mode locks first, then deletes through deleteOsUser (allowPrivileged)", async () => {
    const g = await seedGrant({ onExpiry: "delete", username: "tmpdel" });
    await svc.revokeGrant(g.id, { actor: null });
    expect(scripts[0]).toContain('usermod -L "$u"');
    expect(mocks.deleteOsUser).toHaveBeenCalledWith(serverId, "tmpdel", { removeHome: true, force: true }, {}, undefined, {
      allowPrivileged: true,
    });
  });

  it("an account that is already gone counts as revoked (no delete attempted)", async () => {
    const g = await seedGrant({ onExpiry: "delete", username: "gone" });
    host = () => result({ stdout: "RACKMAP_NO_SUCH_USER\n" });
    expect((await svc.revokeGrant(g.id, { actor: null })).outcome).toBe("revoked");
    expect(mocks.deleteOsUser).not.toHaveBeenCalled();
  });

  it("manual revoke of an unexpired grant emits no expiry alert", async () => {
    const g = await seedGrant({ expiresAt: new Date(Date.now() + HOUR) });
    const r = await svc.revokeGrant(g.id, { actor: { id: adminId, role: "admin" }, audit: { actorId: adminId } });
    expect(r.outcome).toBe("revoked");
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } })).revokedById).toBe(adminId);
    expect(await prisma.alertEvent.count({ where: { serverId } })).toBe(0);
  });

  it("failures count attempts; the fifth marks the grant failed and raises one critical alert", async () => {
    const g = await seedGrant();
    host = () => result({ exitCode: 1, stderr: "usermod: cannot lock tmpuser" });
    for (let i = 1; i <= 5; i++) {
      const r = await svc.revokeGrant(g.id, { actor: null });
      expect(r.outcome).toBe("failed");
      const row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } });
      expect(row.attempts).toBe(i);
      expect(row.lastError).toMatch(/cannot lock/);
      expect(row.status).toBe(i < 5 ? "active" : "failed");
    }
    expect((await svc.revokeGrant(g.id, { actor: null })).outcome).toBe("skipped"); // the sweeper leaves failed grants alone
    const alerts = await prisma.alertEvent.findMany({ where: { dedupKey: `rackmap:access:${g.id}` } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "access_revoke_failed", severity: "critical", action: "trigger" });

    // An admin retry that works resolves the incident.
    host = () => result();
    const r = await svc.revokeGrant(g.id, { actor: { id: adminId, role: "admin" } });
    expect(r.outcome).toBe("revoked");
    const resolved = await prisma.alertEvent.findMany({ where: { dedupKey: `rackmap:access:${g.id}`, action: "resolve" } });
    expect(resolved).toHaveLength(1);
  });

  it("still revokes on a server removed from the inventory; creating or extending there stays refused", async () => {
    const gone = await prisma.server.create({ data: { hostname: "grant-removed.example.com", ip: "192.0.2.13", username: "ops" } });
    // As connectToServer: a soft-deleted server is not_found unless the caller opts in.
    mocks.connectToServer.mockImplementation(async (id: number, opts?: string | { allowDeleted?: boolean }) => {
      const s = await prisma.server.findUnique({ where: { id }, select: { deletedAt: true } });
      if (!s || (s.deletedAt && !(typeof opts === "object" && opts.allowDeleted))) throw new SshError("not_found", "Server not found");
      return { client: { end: vi.fn() }, password: undefined };
    });
    try {
      const key = await seedGrant({ serverId: gone.id, kind: "ssh_key", username: "deploy", onExpiry: "remove", keyFingerprint: KEY_FP });
      const del = await seedGrant({ serverId: gone.id, username: "tmpgone", onExpiry: "delete" });
      const live = await seedGrant({ serverId: gone.id, username: "later", expiresAt: new Date(Date.now() + HOUR) });
      await prisma.server.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

      const r = await runAccessGrantSweep();
      expect(r).toMatchObject({ due: 2, revoked: 2, failed: 0 });
      for (const g of [key, del]) {
        expect(await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ status: "revoked", attempts: 0 });
      }
      expect(mocks.connectToServer.mock.calls.every(([, o]) => typeof o === "object" && o.allowDeleted === true)).toBe(true);
      // deleteOsUser reaches live servers only, so delete mode runs its own userdel after the lock.
      expect(mocks.deleteOsUser).not.toHaveBeenCalled();
      expect(scripts.some((s) => s.includes('userdel -r -f "$u"') && s.includes(escapeShellArg("tmpgone")))).toBe(true);

      // A person can revoke there too (the route's path), with their x-ssh-password.
      mocks.connectToServer.mockClear();
      expect((await svc.revokeGrant(live.id, { actor: { id: adminId, role: "admin" }, sshPassword: "pw" })).outcome).toBe("revoked");
      expect(mocks.connectToServer).toHaveBeenCalledWith(gone.id, { overridePassword: "pw", preferredAuth: "password", allowDeleted: true });

      // Anything that grants access keeps the default and is refused.
      const other = await seedGrant({ serverId: gone.id, username: "later2", expiresAt: new Date(Date.now() + HOUR) });
      await expect(svc.extendGrant(other.id, inHours(3), ctxAdmin)).rejects.toMatchObject({ kind: "not_found" });
      expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("active");
      await expect(
        svc.grantTemporaryKey({ serverId: gone.id, username: "deploy", publicKey: KEY, expiresAt: inHours(2), reason: "x" }, ctxAdmin),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await prisma.alertEvent.deleteMany({ where: { serverId: gone.id } });
      await prisma.server.delete({ where: { id: gone.id } });
    }
  });

  it("connectToServer refuses a soft-deleted server unless allowDeleted is set", async () => {
    const real = await vi.importActual<typeof import("../services/ssh.service.js")>("../services/ssh.service.js");
    const gone = await prisma.server.create({
      data: { hostname: "grant-gone.example.com", ip: "192.0.2.12", username: "ops", deletedAt: new Date() },
    });
    try {
      // No password and a keyId that matches no key file: the call stops before any network I/O.
      const opts = { preferredAuth: "key" as const, keyId: "rackmap-test-no-such-key" };
      await expect(real.connectToServer(gone.id, opts)).rejects.toMatchObject({ kind: "not_found" });
      await expect(real.connectToServer(gone.id, { ...opts, allowDeleted: true })).rejects.toMatchObject({ kind: "no_credentials" });
    } finally {
      await prisma.server.delete({ where: { id: gone.id } });
    }
  });

  it("maps a locked vault to a VAULT_LOCKED failure", async () => {
    const g = await seedGrant();
    mocks.connectToServer.mockRejectedValue(new SshError("vault_locked", "Vault is locked."));
    await svc.revokeGrant(g.id, { actor: null });
    let row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.lastError).toMatch(/^VAULT_LOCKED: /);

    // Key auth worked but sudo needs the vault-encrypted password.
    mocks.connectToServer.mockResolvedValue({ client: { end: vi.fn() }, password: undefined, passwordUnavailable: "vault_locked" });
    host = () => result({ exitCode: 1, errorCode: "SUDO_PASSWORD_REQUIRED", errorMessage: "sudo: a password is required" });
    await svc.revokeGrant(g.id, { actor: null });
    row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.lastError).toMatch(/^VAULT_LOCKED: /);
    expect(row.attempts).toBe(2);
  });
});

describe("runAccessGrantSweep", () => {
  it("two concurrent sweeps revoke an expired grant exactly once", async () => {
    const g = await seedGrant();
    const future = await seedGrant({ username: "notyet", expiresAt: new Date(Date.now() + HOUR) });
    const [a, b] = await Promise.all([runAccessGrantSweep(), runAccessGrantSweep()]);
    expect(a.revoked + b.revoked).toBe(1);
    expect(scripts.filter((s) => s.includes('usermod -L "$u"'))).toHaveLength(1);
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("revoked");
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: future.id } })).status).toBe("active");
    expect(await prisma.alertEvent.count({ where: { serverId, type: "access_expired" } })).toBe(1);
  });

  it("backs off after a failure and releases a stale claim", async () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([0, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    const g = await seedGrant();
    host = () => result({ exitCode: 1, stderr: "boom" });
    await runAccessGrantSweep();
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } })).attempts).toBe(1);
    const again = await runAccessGrantSweep();
    expect(again.due).toBe(0); // within the 1-minute backoff
    const later = await runAccessGrantSweep(new Date(Date.now() + 61_000));
    expect(later.due).toBe(1);

    const stale = await seedGrant({ username: "stale", status: "expired_pending" });
    await prisma.$executeRaw`UPDATE access_grant SET "updatedAt" = now() - interval '1 hour' WHERE id = ${stale.id}`;
    host = () => result();
    const r = await runAccessGrantSweep(new Date(Date.now() + 5 * 60_000));
    expect(r.released).toBe(1);
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("revoked");
  });

  it("grants waiting out a backoff never crowd a newly expired grant out of the batch", async () => {
    // 250 older expired grants, all inside their retry backoff (attempts 1–5, just updated).
    await prisma.accessGrant.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        serverId,
        kind: "os_user",
        username: `backoff${i}`,
        onExpiry: "lock",
        expiresAt: new Date(Date.now() - 2 * HOUR),
        status: "active",
        attempts: 1 + (i % 5),
        createdById: adminId,
      })),
    });
    const fresh = await seedGrant({ username: "fresh" });

    const r = await runAccessGrantSweep();
    expect(r).toMatchObject({ due: 1, revoked: 1, failed: 0 });
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("revoked");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(`u=${escapeShellArg("fresh")}`);
    expect(await prisma.accessGrant.count({ where: { status: "active", attempts: { gt: 0 } } })).toBe(250);
  });

  it("the query applies retryDelayMs exactly, for every attempts count", async () => {
    for (const attempts of [1, 2, 3, 4, 5, 9]) {
      await prisma.accessGrant.deleteMany({});
      const g = await seedGrant({ attempts });
      const t0 = g.updatedAt.getTime();
      expect((await runAccessGrantSweep(new Date(t0 + retryDelayMs(attempts) - 1000))).due).toBe(0);
      expect((await runAccessGrantSweep(new Date(t0 + retryDelayMs(attempts)))).due).toBe(1);
    }
  });
});

// ─── Extend ──────────────────────────────────────────────────────────────────

describe("extendGrant", () => {
  it("updates expiry-time on the host and the row, and audits it", async () => {
    const g = await seedGrant({ kind: "ssh_key", username: "deploy", onExpiry: "remove", keyFingerprint: KEY_FP, expiresAt: new Date(Date.now() + HOUR), createdById: editorId });
    const next = new Date(Date.now() + 5 * HOUR);
    const { grant } = await svc.extendGrant(g.id, next.toISOString(), ctxEditor);
    expect(grant.expiresAt.toISOString()).toBe(next.toISOString());
    expect(grant.status).toBe("active");
    expect(scripts[0]).toContain(`${escapeShellArg("update")} "$home"`);
    expect(scripts[0]).toContain(`date -d @${escapeShellArg(String(svc.keyExpiryEpoch(next)))}`);
    expect(await prisma.auditLog.count({ where: { action: "access_grant.extend", entityId: String(g.id) } })).toBe(1);
  });

  it("os_user: re-runs chage with the new day; a failed host step leaves the row untouched", async () => {
    const g = await seedGrant({ expiresAt: new Date(Date.now() + HOUR), createdById: editorId });
    const next = new Date(Date.now() + 48 * HOUR);
    host = () => result({ exitCode: 1, stderr: "chage: failure" });
    await expect(svc.extendGrant(g.id, next.toISOString(), ctxEditor)).rejects.toThrow(/chage: failure/);
    let row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.status).toBe("active");
    expect(row.expiresAt.getTime()).toBeLessThan(next.getTime());

    host = () => result();
    await svc.extendGrant(g.id, next.toISOString(), ctxEditor);
    expect(scripts.at(-1)).toContain(`chage -E ${escapeShellArg(String(svc.hostAccountExpiryDay(next)))}`);
    row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.expiresAt.toISOString()).toBe(next.toISOString());
  });

  it("refuses an expired grant, someone else's grant for an editor, and a busy grant", async () => {
    const expired = await seedGrant({ createdById: editorId });
    await expect(svc.extendGrant(expired.id, inHours(2), ctxEditor)).rejects.toMatchObject({ status: 409 });
    const others = await seedGrant({ expiresAt: new Date(Date.now() + HOUR), createdById: adminId });
    await expect(svc.extendGrant(others.id, inHours(2), ctxEditor)).rejects.toMatchObject({ status: 403 });
    const busy = await seedGrant({ expiresAt: new Date(Date.now() + HOUR), status: "expired_pending" });
    await expect(svc.extendGrant(busy.id, inHours(2), ctxAdmin)).rejects.toMatchObject({ status: 409 });
    expect(scripts).toHaveLength(0);
  });
});
