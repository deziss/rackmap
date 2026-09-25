import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { APT_UPGRADABLE, applyOutput, execResult, scanOutput } from "./patch-fixtures.js";

/**
 * patch.service against a fake host: connectToServer and the remote-exec
 * helpers are mocked; the database and emitAlert are real, so the stored row
 * and the alert events are what production would write.
 */

const mocks = vi.hoisted(() => ({
  connectToServer: vi.fn(),
  execPreferRoot: vi.fn(),
  execAsRoot: vi.fn(),
}));

vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});
vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execPreferRoot: mocks.execPreferRoot, execAsRoot: mocks.execAsRoot };
});

const {
  applyServerPatches,
  getPatchSummary,
  getServerPatchStatus,
  listPatchFleet,
  scanServerPatches,
} = await import("../services/patch.service.js");
const { runPatchSweep } = await import("../services/patch-scheduler.js");
const { prisma } = await import("../db.js");
const { AppError } = await import("../lib/errors.js");
const { SshError } = await import("../services/ssh.service.js");
const { RemoteFailureError } = await import("../services/remote-exec.service.js");

const ctx = { actorId: null, actorEmail: "admin@inventory.local", ip: "192.0.2.200" };
let serverId = 0;
let otherId = 0;
let host: { scan: string };

const APT_ONE_SEC = [
  "Listing...",
  "openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]",
].join("\n");

async function makeServer(hostname: string, ip: string) {
  const s = await prisma.server.create({ data: { hostname, ip, username: "deploy", environment: "on-premise" } });
  return s.id;
}

async function alertCount(key: string, action: string) {
  return prisma.alertEvent.count({ where: { dedupKey: key, action } });
}

beforeAll(async () => {
  serverId = await makeServer("patch-svc-1.example.com", "192.0.2.51");
  otherId = await makeServer("patch-svc-2.example.com", "192.0.2.52");
});

beforeEach(() => {
  host = { scan: scanOutput({ upg: APT_UPGRADABLE }) };
  mocks.connectToServer.mockReset().mockImplementation(async (id: number) => ({
    client: { end: vi.fn() },
    password: "ssh-pw",
    target: { id, hostname: "patch-svc.example.com", ip: "192.0.2.51", username: "deploy", sshPort: 22 },
  }));
  mocks.execPreferRoot.mockReset().mockImplementation(async () => ({ ...execResult(host.scan), ranAsRoot: true }));
  mocks.execAsRoot.mockReset().mockRejectedValue(new Error("execAsRoot must not be reached in this test"));
});

describe("scanServerPatches", () => {
  it("upserts the status row from the host's answer", async () => {
    const dto = await scanServerPatches(serverId, { refresh: true });
    expect(dto).toMatchObject({ serverId, status: "ok", packageManager: "apt", upgradableCount: 3, securityCount: 2 });
    const script = mocks.execPreferRoot.mock.calls[0]![1] as string;
    expect(script).toMatch(/^REFRESH=1$/m);

    const again = await scanServerPatches(serverId, { refresh: false });
    expect(again.upgradableCount).toBe(3);
    expect(await prisma.serverPatchStatus.count({ where: { serverId } })).toBe(1);
    expect((mocks.execPreferRoot.mock.calls[1]![1] as string)).toMatch(/^REFRESH=0$/m);

    const stored = await getServerPatchStatus(serverId);
    expect(stored?.packages.map((p) => p.name)).toEqual(["libssl3", "openssl", "curl"]);
    expect(stored?.packagesTruncated).toBe(false);
  });

  it("returns null for a never-scanned server and 404 for a missing one", async () => {
    const fresh = await makeServer("patch-svc-fresh.example.com", "192.0.2.53");
    expect(await getServerPatchStatus(fresh)).toBeNull();
    await expect(getServerPatchStatus(999_999)).rejects.toMatchObject({ status: 404 });
  });

  it("fires patch_available once on 0 → >0 and resolves on → 0", async () => {
    const id = await makeServer("patch-svc-alert.example.com", "192.0.2.54");
    const key = `rackmap:patch:${id}`;

    host.scan = scanOutput({ upg: "Listing...\n" });
    await scanServerPatches(id);
    expect(await alertCount(key, "trigger")).toBe(0);

    host.scan = scanOutput({ upg: APT_ONE_SEC });
    await scanServerPatches(id);
    expect(await alertCount(key, "trigger")).toBe(1);

    host.scan = scanOutput({ upg: APT_UPGRADABLE });
    await scanServerPatches(id);
    expect(await alertCount(key, "trigger")).toBe(1);

    host.scan = scanOutput({ upg: "Listing...\n" });
    await scanServerPatches(id);
    await scanServerPatches(id);
    expect(await alertCount(key, "resolve")).toBe(1);
    expect(await alertCount(key, "trigger")).toBe(1);

    const ev = await prisma.alertEvent.findFirst({ where: { dedupKey: key, action: "trigger" } });
    expect(ev).toMatchObject({ type: "patch_available", serverId: id });
    expect(ev?.title).toMatch(/1 security update available/);
  });

  it("fires reboot_required on the flag's rising edge only", async () => {
    const id = await makeServer("patch-svc-reboot.example.com", "192.0.2.55");
    const key = `rackmap:reboot:${id}`;
    host.scan = scanOutput({ reboot: "yes" });
    await scanServerPatches(id);
    await scanServerPatches(id);
    expect(await alertCount(key, "trigger")).toBe(1);
    host.scan = scanOutput({ reboot: "no" });
    await scanServerPatches(id);
    expect(await alertCount(key, "resolve")).toBe(1);
  });

  it("records a failed scan without losing the last counts or moving alerts", async () => {
    const id = await makeServer("patch-svc-fail.example.com", "192.0.2.56");
    const key = `rackmap:patch:${id}`;
    host.scan = scanOutput({ upg: APT_UPGRADABLE });
    await scanServerPatches(id);
    expect(await alertCount(key, "trigger")).toBe(1);

    mocks.execPreferRoot.mockResolvedValueOnce({
      ...execResult("", { exitCode: null, errorCode: "UPLOAD_FAILED", errorMessage: "Could not open an SSH channel on the host" }),
      ranAsRoot: true,
    });
    await expect(scanServerPatches(id)).rejects.toBeInstanceOf(RemoteFailureError);
    let row = await prisma.serverPatchStatus.findUniqueOrThrow({ where: { serverId: id } });
    expect(row).toMatchObject({ status: "error", securityCount: 2, upgradableCount: 3 });
    expect(row.error).toMatch(/SSH channel/);

    mocks.connectToServer.mockRejectedValueOnce(new SshError("unreachable", "connect ETIMEDOUT"));
    await expect(scanServerPatches(id)).rejects.toBeInstanceOf(SshError);
    row = await prisma.serverPatchStatus.findUniqueOrThrow({ where: { serverId: id } });
    expect(row).toMatchObject({ status: "error", securityCount: 2, error: "Server is unreachable over SSH" });

    // A garbled answer is stored as an error too, and still does not resolve the incident.
    host.scan = scanOutput({ end: false });
    const dto = await scanServerPatches(id);
    expect(dto).toMatchObject({ status: "error", securityCount: 2 });
    expect(await alertCount(key, "resolve")).toBe(0);

    // Back to good with the same count: no second trigger.
    host.scan = scanOutput({ upg: APT_UPGRADABLE });
    expect((await scanServerPatches(id)).status).toBe("ok");
    expect(await alertCount(key, "trigger")).toBe(1);
  });

  it("stores unsupported hosts", async () => {
    const id = await makeServer("patch-svc-alpine.example.com", "192.0.2.57");
    host.scan = scanOutput({ pm: "unknown" });
    expect(await scanServerPatches(id)).toMatchObject({ status: "unsupported", packageManager: "unknown", upgradableCount: 0 });
  });

  it("joins a scan that is already running for the same server", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mocks.execPreferRoot.mockImplementationOnce(async () => {
      await gate;
      return { ...execResult(host.scan), ranAsRoot: true };
    });
    const a = scanServerPatches(otherId);
    const b = scanServerPatches(otherId);
    release();
    await Promise.all([a, b]);
    expect(mocks.connectToServer).toHaveBeenCalledTimes(1);
  });

  it("joins only an equivalent scan: a refresh or a password override runs its own", async () => {
    // The vault is locked: only a caller-supplied password gets a session.
    mocks.connectToServer.mockImplementation(async (id: number, pw?: string) => {
      if (!pw) throw new SshError("vault_locked", "vault is locked");
      return { client: { end: vi.fn() }, password: pw, target: { id } };
    });
    const plain = scanServerPatches(otherId);
    const withPw = scanServerPatches(otherId, { overridePassword: "typed-pw" }); // never joins
    const plainAgain = scanServerPatches(otherId); // never joins the override scan
    const refreshed = scanServerPatches(otherId, { refresh: true, overridePassword: "typed-pw" });
    expect(plainAgain).toBe(plain);
    expect(withPw).not.toBe(plain);

    await expect(plain).rejects.toMatchObject({ kind: "vault_locked" });
    await expect(withPw).resolves.toMatchObject({ serverId: otherId, status: "ok" });
    await expect(refreshed).resolves.toMatchObject({ serverId: otherId, status: "ok" });
    expect(mocks.connectToServer).toHaveBeenCalledTimes(3);
    const scripts = mocks.execPreferRoot.mock.calls.map((c) => c[1] as string);
    expect(scripts.filter((s) => /^REFRESH=1$/m.test(s))).toHaveLength(1);
    expect(scripts.filter((s) => /^REFRESH=0$/m.test(s))).toHaveLength(1);

    // A refresh never joins a plain scan either.
    mocks.connectToServer
      .mockReset()
      .mockImplementation(async (id: number) => ({ client: { end: vi.fn() }, password: "ssh-pw", target: { id } }));
    const a = scanServerPatches(otherId, { refresh: false });
    const b = scanServerPatches(otherId, { refresh: true });
    expect(b).not.toBe(a);
    await Promise.all([a, b]);
    expect(mocks.connectToServer).toHaveBeenCalledTimes(2);
  });
});

describe("applyServerPatches", () => {
  it("refuses security-only on an apt host without unattended-upgrades, before changing anything", async () => {
    mocks.execAsRoot.mockResolvedValueOnce(execResult(applyOutput({ refused: "NO_UNATTENDED_UPGRADE" })));
    const err = await applyServerPatches(serverId, { mode: "security" }, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 409 });
    expect(err.message).toMatch(/unattended-upgrades/);
    expect(mocks.execPreferRoot).not.toHaveBeenCalled();
    expect(await prisma.auditLog.count({ where: { action: "server.patch_apply", entityId: String(serverId) } })).toBe(0);
  });

  it("runs as root, rescans, stamps lastAppliedAt and audits", async () => {
    mocks.execAsRoot.mockResolvedValueOnce(
      execResult(applyOutput({ rc: "0", output: "Setting up openssl (3.0.2-0ubuntu1.15) ...\n" }), { durationMs: 61_000 }),
    );
    host.scan = scanOutput({ upg: "Listing...\n", reboot: "yes" });
    const res = await applyServerPatches(serverId, { mode: "all" }, ctx);
    expect(res).toMatchObject({ ok: true, mode: "all", packageManager: "apt", exitCode: 0, durationMs: 61_000, rescanError: null });
    expect(res.output).toContain("Setting up openssl");
    expect(res.status).toMatchObject({ upgradableCount: 0, securityCount: 0, rebootRequired: true });
    expect(res.status?.lastAppliedAt).not.toBeNull();

    const [, script, password, opts] = mocks.execAsRoot.mock.calls[0]!;
    expect(script).toContain("dist-upgrade");
    expect(password).toBe("ssh-pw");
    expect(opts).toMatchObject({ timeoutMs: 30 * 60 * 1000 });

    const row = await prisma.serverPatchStatus.findUniqueOrThrow({ where: { serverId } });
    expect(row.lastAppliedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "server.patch_apply", entityId: String(serverId) } });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({ mode: "all", ok: true, exitCode: 0, upgradableCount: 0 });
  });

  it("reports a failed package-manager run without throwing", async () => {
    mocks.execAsRoot.mockResolvedValueOnce(
      execResult(applyOutput({ pm: "dnf", cmd: "dnf -y upgrade", rc: "1", output: "Error: Transaction test error\n" })),
    );
    const res = await applyServerPatches(otherId, { mode: "all" }, ctx);
    expect(res).toMatchObject({ ok: false, exitCode: 1, packageManager: "dnf", command: "dnf -y upgrade" });
  });

  it("does not stamp lastAppliedAt when the run failed, but still rescans and audits it", async () => {
    const id = await makeServer("patch-svc-dpkg-lock.example.com", "192.0.2.58");
    mocks.execAsRoot.mockResolvedValueOnce(
      execResult(applyOutput({ rc: "100", output: "E: Could not get lock /var/lib/dpkg/lock-frontend\n" })),
    );
    const res = await applyServerPatches(id, { mode: "all" }, ctx);
    expect(res).toMatchObject({ ok: false, exitCode: 100, packageManager: "apt", rescanError: null });
    expect(res.status).toMatchObject({ status: "ok", upgradableCount: 3, lastAppliedAt: null });
    expect(mocks.execPreferRoot).toHaveBeenCalledTimes(1);
    expect((await prisma.serverPatchStatus.findUniqueOrThrow({ where: { serverId: id } })).lastAppliedAt).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "server.patch_apply", entityId: String(id) } });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({ mode: "all", ok: false, exitCode: 100, upgradableCount: 3 });

    // Output cut off before END: not a success either.
    mocks.execAsRoot.mockResolvedValueOnce(execResult(applyOutput({ rc: "0" }).replace("===END===\n", "")));
    expect(await applyServerPatches(id, { mode: "all" }, ctx)).toMatchObject({ ok: false, status: { lastAppliedAt: null } });
    expect((await prisma.serverPatchStatus.findUniqueOrThrow({ where: { serverId: id } })).lastAppliedAt).toBeNull();

    // The next successful run does stamp it.
    mocks.execAsRoot.mockResolvedValueOnce(execResult(applyOutput({ rc: "0" })));
    const good = await applyServerPatches(id, { mode: "all" }, ctx);
    expect(good.ok).toBe(true);
    expect(good.status?.lastAppliedAt).not.toBeNull();
    expect((await prisma.serverPatchStatus.findUniqueOrThrow({ where: { serverId: id } })).lastAppliedAt).not.toBeNull();
  });

  it("maps sudo failures and refuses a concurrent apply", async () => {
    mocks.execAsRoot.mockResolvedValueOnce(
      execResult("", { exitCode: 1, errorCode: "SUDO_NOT_ALLOWED", errorMessage: "the SSH user is not allowed to run commands as root with sudo" }),
    );
    await expect(applyServerPatches(serverId, { mode: "all" }, ctx)).rejects.toMatchObject({ status: 409, code: "SUDO_ERROR" });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mocks.execAsRoot.mockImplementationOnce(async () => {
      await gate;
      return execResult(applyOutput({ rc: "0" }));
    });
    const first = applyServerPatches(serverId, { mode: "all" }, ctx);
    await vi.waitFor(() => expect(mocks.execAsRoot).toHaveBeenCalledTimes(2));
    await expect(applyServerPatches(serverId, { mode: "all" }, ctx)).rejects.toMatchObject({ status: 409 });
    release();
    await first;
  });
});

describe("fleet report and sweep", () => {
  it("lists every server, never-scanned last, with filters", async () => {
    const all = await listPatchFleet({ limit: 1000 });
    const ids = all.items.map((i) => i.serverId);
    expect(ids).toContain(serverId);
    const firstNever = all.items.findIndex((i) => i.patch === null);
    if (firstNever >= 0) expect(all.items.slice(firstNever).every((i) => i.patch === null)).toBe(true);

    const sec = await listPatchFleet({ limit: 1000, securityOnly: true });
    expect(sec.items.every((i) => (i.patch?.securityCount ?? 0) > 0)).toBe(true);
    const never = await listPatchFleet({ limit: 1000, status: "never" });
    expect(never.items.every((i) => i.patch === null)).toBe(true);
    const q = await listPatchFleet({ limit: 10, q: "PATCH-SVC-ALPINE" });
    expect(q.items.map((i) => i.hostname)).toEqual(["patch-svc-alpine.example.com"]);
    const paged = await listPatchFleet({ limit: 2, page: 2, sortBy: "hostname", sortDir: "asc" });
    expect(paged.page).toBe(2);
    expect(paged.items.length).toBeLessThanOrEqual(2);
  });

  it("summarises the fleet", async () => {
    const s = await getPatchSummary();
    expect(s.scanned).toBeGreaterThan(0);
    expect(s.unsupported).toBeGreaterThanOrEqual(1);
    expect(s.totalServers).toBe(s.scanned + s.neverScanned);
  });

  it("keeps sweeping when one host fails", async () => {
    mocks.connectToServer.mockImplementation(async (id: number) => {
      if (id === otherId) throw new SshError("auth_failed", "SSH authentication failed");
      return { client: { end: vi.fn() }, password: "ssh-pw", target: { id } };
    });
    const res = await runPatchSweep();
    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect(res.ok).toBeGreaterThanOrEqual(1);
    expect(res.ok + res.failed).toBe(res.total);
    const row = await prisma.serverPatchStatus.findUniqueOrThrow({ where: { serverId: otherId } });
    expect(row.status).toBe("error");
  });
});
