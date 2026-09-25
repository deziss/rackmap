import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * systemd.service against a fake host: remote-exec and connectToServer are
 * mocked, and the mock "executes" the generated scripts by recognising their
 * shape and answering in the marker/base64 protocol the real scripts print.
 */

const mocks = vi.hoisted(() => ({
  execAsRoot: vi.fn(),
  execPreferRoot: vi.fn(),
  connectToServer: vi.fn(),
}));

vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execAsRoot: mocks.execAsRoot, execPreferRoot: mocks.execPreferRoot };
});
vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});

const {
  buildSystemdActionScript,
  buildSystemdListScript,
  buildSystemdLogsScript,
  buildSystemdResolveScript,
  buildSystemdShowScript,
  getSystemdUnit,
  getSystemdUnitLogs,
  listSystemdUnits,
  runSystemdAction,
  systemdErrorToHttp,
} = await import("../services/systemd.service.js");
const { AppError } = await import("../lib/errors.js");
const { escapeShellArg } = await import("../services/shell-escape.js");
const { RemoteFailureError } = await import("../services/remote-exec.service.js");
const { SshError } = await import("../services/ssh.service.js");
const { prisma } = await import("../db.js");

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const block = (header: string, payload?: string) => `===${header}===\n${payload === undefined ? "" : b64(payload) + "\n"}`;
const ctx = { actorId: null, actorEmail: "editor@example.com", ip: "192.0.2.10" };

interface FakeUnit {
  active: string;
  sub: string;
  enabled: string;
  description: string;
  names?: string[];
  load?: string;
}

interface FakeHost {
  systemd: boolean;
  units: Record<string, FakeUnit>;
  /** alias → canonical unit */
  aliases: Record<string, string>;
  /** Exit status and output of the next systemctl action. */
  actionRc: number;
  actionOut: string;
  ranAsRoot: boolean;
  scripts: string[];
}

let host: FakeHost;

function result(stdout: string, extra: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    durationMs: 12,
    ...extra,
  };
}

function canonical(name: string): string {
  return host.aliases[name] ?? name;
}

function showState(name: string): string {
  const id = canonical(name);
  const u = host.units[id];
  if (!u) return `Id=${id}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n`;
  return `Id=${id}\nLoadState=${u.load ?? "loaded"}\nActiveState=${u.active}\nSubState=${u.sub}\nUnitFileState=${u.enabled}\n`;
}

/** Answer a generated script the way the host would. */
function fakeExec(_client: unknown, script: string) {
  host.scripts.push(script);
  if (!host.systemd) return result("===NOSYSTEMD===\n===END===\n");
  const unit = /^U='([^']*)'$/m.exec(script)?.[1];

  if (script.includes("systemctl list-units")) {
    const rows = Object.entries(host.units)
      .filter(([, u]) => u.load !== "not-loaded")
      .map(([n, u]) => `${n}   ${u.load ?? "loaded"}   ${u.active}   ${u.sub}   ${u.description}`)
      .join("\n");
    const files = Object.entries(host.units)
      .map(([n, u]) => `${n}   ${u.enabled}   enabled`)
      .join("\n");
    return result(`${block("UNITS", rows + "\n")}${block("FILES", files + "\n")}===END===\n`);
  }
  if (script.includes("-p Id,Names,LoadState")) {
    const id = canonical(unit!);
    const names = [id, ...Object.entries(host.aliases).filter(([, c]) => c === id).map(([a]) => a)];
    return result(`${block("SHOW", `Id=${id}\nNames=${names.join(" ")}\nLoadState=loaded\n`)}===END===\n`);
  }
  const action = /^A='([a-z]+)'$/m.exec(script)?.[1];
  if (action) {
    const before = showState(unit!);
    const u = host.units[canonical(unit!)];
    if (u && host.actionRc === 0) {
      if (action === "stop") Object.assign(u, { active: "inactive", sub: "dead" });
      if (action === "start" || action === "restart") Object.assign(u, { active: "active", sub: "running" });
      if (action === "enable") u.enabled = "enabled";
      if (action === "disable") u.enabled = "disabled";
    }
    return result(
      `${block("BEFORE", before)}${block("RC", String(host.actionRc))}${block("OUT", host.actionOut)}${block("AFTER", showState(unit!))}===END===\n`,
    );
  }
  if (script.includes("emit LOGS")) {
    return result(`${block("LOGS", `2026-09-25T10:00:00+0000 web-1 ${unit}: one\n2026-09-25T10:00:01+0000 web-1 ${unit}: two\n`)}===END===\n`);
  }
  if (script.includes("-p Id,Description,")) {
    const u = host.units[canonical(unit!)];
    const show = u
      ? `${showState(unit!)}Description=${u.description}\nMainPID=4242\nExecMainStartTimestamp=Fri 2026-09-25 10:00:00 UTC\nMemoryCurrent=1048576\nFragmentPath=/lib/systemd/system/${canonical(unit!)}\nRestart=on-failure\nNRestarts=0\n`
      : showState(unit!);
    return result(`${block("SHOW", show)}${block("JOURNAL", "-- No entries --\n")}===END===\n`);
  }
  throw new Error(`unexpected script:\n${script}`);
}

const clientEnd = vi.fn();

beforeEach(() => {
  host = {
    systemd: true,
    units: {
      "nginx.service": { active: "active", sub: "running", enabled: "enabled", description: "A high performance web server" },
      "ssh.service": { active: "active", sub: "running", enabled: "enabled", description: "OpenBSD Secure Shell server" },
      "systemd-resolved.service": { active: "active", sub: "running", enabled: "enabled", description: "Network Name Resolution" },
      "rsync.service": { active: "inactive", sub: "dead", enabled: "disabled", description: "", load: "not-loaded" },
      "getty@tty1.service": { active: "active", sub: "running", enabled: "enabled", description: "Getty on tty1" },
    },
    aliases: {
      "sshd.service": "ssh.service",
      "dbus-org.freedesktop.resolve1.service": "systemd-resolved.service",
      "web.service": "nginx.service",
    },
    actionRc: 0,
    actionOut: "",
    ranAsRoot: true,
    scripts: [],
  };
  clientEnd.mockReset();
  mocks.connectToServer.mockReset().mockResolvedValue({
    client: { end: clientEnd },
    password: "ssh-pw",
    target: { id: 1, hostname: "web-1.example.com", ip: "192.0.2.1", username: "deploy", sshPort: 22 },
  });
  mocks.execAsRoot.mockReset().mockImplementation(async (client: unknown, script: string) => fakeExec(client, script));
  mocks.execPreferRoot
    .mockReset()
    .mockImplementation(async (client: unknown, script: string) => ({ ...fakeExec(client, script), ranAsRoot: host.ranAsRoot }));
});

async function expectAppError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as InstanceType<typeof AppError>).code).toBe(code);
  expect((err as InstanceType<typeof AppError>).status).toBe(status);
  return err as InstanceType<typeof AppError>;
}

const HOSTILE = [
  "nginx",
  "foo;reboot.service",
  "$(reboot).service",
  "`reboot`.service",
  "a b.service",
  "x'; reboot; echo '.service",
  "nginx.service\nreboot",
  "--help.service",
  "../../etc/passwd.service",
  "dev-disk-by\\x2duuid.mount",
  "*.service",
  `${"a".repeat(201)}.service`,
];

describe("hostile unit names", () => {
  it.each(HOSTILE)("are rejected before any SSH: %j", async (name) => {
    await expectAppError(getSystemdUnit(1, name), "VALIDATION_ERROR", 400);
    await expectAppError(getSystemdUnitLogs(1, name, { lines: 10 }), "VALIDATION_ERROR", 400);
    await expectAppError(runSystemdAction(1, name, "restart", ctx, { canSudo: true }), "VALIDATION_ERROR", 400);
    expect(() => buildSystemdShowScript(name)).toThrow(AppError);
    expect(() => buildSystemdLogsScript(name, 10)).toThrow(AppError);
    expect(() => buildSystemdActionScript(name, "start")).toThrow(AppError);
    expect(() => buildSystemdResolveScript(name)).toThrow(AppError);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
    expect(mocks.execAsRoot).not.toHaveBeenCalled();
    expect(mocks.execPreferRoot).not.toHaveBeenCalled();
  });

  it("rejects an unknown action, a bad line count and a bad since before any SSH", async () => {
    await expectAppError(runSystemdAction(1, "nginx.service", "mask" as never, ctx, { canSudo: true }), "VALIDATION_ERROR", 400);
    await expectAppError(getSystemdUnitLogs(1, "nginx.service", { lines: 0 }), "VALIDATION_ERROR", 400);
    await expectAppError(getSystemdUnitLogs(1, "nginx.service", { lines: 2001 }), "VALIDATION_ERROR", 400);
    await expectAppError(getSystemdUnitLogs(1, "nginx.service", { lines: 10, since: "1h'; reboot; '" }), "VALIDATION_ERROR", 400);
    await expectAppError(listSystemdUnits(1, { type: "device" as never }), "VALIDATION_ERROR", 400);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });
});

describe("generated scripts", () => {
  const UNIT = "getty@tty1.service";
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it.each([
    ["show", () => buildSystemdShowScript(UNIT)],
    ["logs", () => buildSystemdLogsScript(UNIT, 200, "1h")],
    ["resolve", () => buildSystemdResolveScript(UNIT)],
    ["action", () => buildSystemdActionScript(UNIT, "restart")],
  ])("%s: the unit appears once, only as U=escapeShellArg(unit), and is used as \"$U\"", (_name, build) => {
    const script = build();
    expect(occurrences(script, UNIT)).toBe(1);
    expect(occurrences(script, escapeShellArg(UNIT))).toBe(1);
    expect(script).toContain(`\nU=${escapeShellArg(UNIT)}\n`);
    expect(script).toMatch(/"\$U"/);
  });

  it("passes systemctl `--` before the unit and journalctl the unit as --unit=", () => {
    expect(buildSystemdShowScript(UNIT)).toContain('systemctl show --no-pager -p Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStartTimestamp,MemoryCurrent,FragmentPath,Restart,NRestarts -- "$U"');
    expect(buildSystemdShowScript(UNIT)).toContain('journalctl --unit="$U" -n 20 --no-pager -o short-iso');
    const action = buildSystemdActionScript(UNIT, "restart");
    expect(action).toContain(`A=${escapeShellArg("restart")}`);
    expect(action).toContain('systemctl --no-ask-password "$A" -- "$U"');
  });

  it("escapes the journal arguments", () => {
    const s = buildSystemdLogsScript("nginx.service", 500, "2026-09-25T10:00");
    expect(s).toContain(`-n ${escapeShellArg("500")}`);
    expect(s).toContain(`--since=${escapeShellArg("2026-09-25 10:00:00")}`);
    expect(buildSystemdLogsScript("nginx.service", 50, "30m")).toContain(`--since=${escapeShellArg("-30min")}`);
    expect(buildSystemdLogsScript("nginx.service", 50)).not.toContain("--since");
  });

  it("the list script only interpolates the constant type list", () => {
    expect(buildSystemdListScript("service")).toContain(`T=${escapeShellArg("service")}`);
    expect(buildSystemdListScript("all")).toContain(`T=${escapeShellArg("service,timer,socket,target,path,mount")}`);
    expect(buildSystemdListScript("timer")).toContain('systemctl list-units --all --no-pager --plain --no-legend --full --type="$T"');
  });

  it("every script bails out cleanly on a host without systemd", () => {
    for (const s of [buildSystemdListScript("all"), buildSystemdShowScript(UNIT), buildSystemdActionScript(UNIT, "stop")]) {
      expect(s).toContain("[ ! -d /run/systemd/system ]; then emit NOSYSTEMD; emit END; exit 0; fi");
    }
  });
});

describe("listSystemdUnits", () => {
  it("lists loaded and unloaded units with their enablement, reading via execPreferRoot", async () => {
    const res = await listSystemdUnits(1, { type: "service" });
    expect(res.supported).toBe(true);
    expect(res.ranAsRoot).toBe(true);
    expect(res.units.map((u) => u.unit)).toEqual([
      "getty@tty1.service",
      "nginx.service",
      "rsync.service",
      "ssh.service",
      "systemd-resolved.service",
    ]);
    expect(res.units.find((u) => u.unit === "rsync.service")).toMatchObject({ load: "not-loaded", active: "inactive", enabled: "disabled" });
    expect(mocks.execPreferRoot).toHaveBeenCalledTimes(1);
    expect(mocks.execAsRoot).not.toHaveBeenCalled();
    expect(clientEnd).toHaveBeenCalledTimes(1);
  });

  it("filters by q on name and description, in the API", async () => {
    const res = await listSystemdUnits(1, { type: "service", q: "SHELL" });
    expect(res.units.map((u) => u.unit)).toEqual(["ssh.service"]);
    expect(host.scripts[0]).not.toContain("SHELL");
  });

  it("reports a host without systemd as unsupported", async () => {
    host.systemd = false;
    expect(await listSystemdUnits(1, { type: "all" })).toEqual({ supported: false, units: [] });
  });

  it("says when the read ran without root", async () => {
    host.ranAsRoot = false;
    expect((await listSystemdUnits(1, { type: "service" })).ranAsRoot).toBe(false);
  });
});

describe("getSystemdUnit / getSystemdUnitLogs", () => {
  it("returns the unit's properties and journal", async () => {
    const d = await getSystemdUnit(1, "nginx.service");
    expect(d).toMatchObject({
      unit: "nginx.service",
      id: "nginx.service",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      mainPid: 4242,
      memoryBytes: 1048576,
      restart: "on-failure",
      nRestarts: 0,
      journal: ["-- No entries --"],
    });
  });

  it("404s a unit the host does not know", async () => {
    await expectAppError(getSystemdUnit(1, "nope.service"), "NOT_FOUND", 404);
  });

  it("409s on a host without systemd", async () => {
    host.systemd = false;
    await expectAppError(getSystemdUnit(1, "nginx.service"), "CONFLICT", 409);
    await expectAppError(getSystemdUnitLogs(1, "nginx.service", { lines: 5 }), "CONFLICT", 409);
  });

  it("returns journal lines", async () => {
    const res = await getSystemdUnitLogs(1, "nginx.service", { lines: 200, since: "1h" });
    expect(res.lines).toHaveLength(2);
    expect(res.truncated).toBe(false);
    expect(host.scripts[0]).toContain(`--since=${escapeShellArg("-1h")}`);
  });
});

describe("runSystemdAction", () => {
  it("runs the action as root, returns the new state and writes the audit row", async () => {
    const res = await runSystemdAction(1, "nginx.service", "stop", ctx);
    expect(res).toEqual({
      unit: "nginx.service",
      action: "stop",
      ok: true,
      exitCode: 0,
      activeState: "inactive",
      subState: "dead",
      unitFileState: "enabled",
      stderr: "",
    });
    // Editor path: one resolve script, then the action script.
    expect(host.scripts).toHaveLength(2);
    expect(host.scripts[0]).toContain("-p Id,Names,LoadState");
    expect(host.scripts[1]).toContain(`A=${escapeShellArg("stop")}`);
    expect(mocks.execPreferRoot).not.toHaveBeenCalled();

    const row = await prisma.auditLog.findFirst({ where: { action: "server.systemd_action" }, orderBy: { id: "desc" } });
    expect(row?.category).toBe("security");
    expect(row?.entityId).toBe("1");
    expect(JSON.parse(row!.afterJson!)).toMatchObject({ unit: "nginx.service", action: "stop", outcome: "succeeded", ok: true, exitCode: 0, activeState: "inactive" });
    expect(JSON.parse(row!.beforeJson!)).toMatchObject({ unit: "nginx.service", activeState: "active" });
  });

  it("reports a failed systemctl with its output (and audits it)", async () => {
    host.actionRc = 1;
    host.actionOut = "Job for nginx.service failed because the control process exited with error code.";
    const res = await runSystemdAction(1, "nginx.service", "reload", ctx, { canSudo: true });
    expect(res).toMatchObject({ ok: false, exitCode: 1, activeState: "active", stderr: host.actionOut });
    const row = await prisma.auditLog.findFirst({ where: { action: "server.systemd_action" }, orderBy: { id: "desc" } });
    expect(JSON.parse(row!.afterJson!)).toMatchObject({ action: "reload", outcome: "failed", ok: false, exitCode: 1 });
  });

  it("with server:sudo skips the alias resolve step", async () => {
    await runSystemdAction(1, "nginx.service", "restart", ctx, { canSudo: true });
    expect(host.scripts).toHaveLength(1);
  });

  describe("protected-unit rule", () => {
    it.each([
      ["sshd.service", "stop"],
      ["ssh.service", "restart"],
      ["ssh.socket", "disable"],
      ["systemd-networkd.service", "stop"],
      ["getty@tty1.service", "stop"],
      ["reboot.target", "start"],
      ["systemd-poweroff.service", "start"],
      ["debug-shell.service", "enable"],
    ] as const)("%s %s without server:sudo is 403 before any SSH", async (unit, action) => {
      const err = await expectAppError(runSystemdAction(1, unit, action, ctx), "FORBIDDEN", 403);
      expect(err.message).toMatch(/server:sudo/);
      expect(mocks.connectToServer).not.toHaveBeenCalled();
    });

    it("allows start and reload of a protected unit without server:sudo", async () => {
      host.units["ssh.service"]!.active = "inactive";
      expect((await runSystemdAction(1, "ssh.service", "start", ctx)).activeState).toBe("active");
      expect((await runSystemdAction(1, "sshd.service", "reload", ctx)).ok).toBe(true);
    });

    it("allows stopping a protected unit with server:sudo", async () => {
      const res = await runSystemdAction(1, "sshd.service", "stop", ctx, { canSudo: true });
      expect(res.ok).toBe(true);
      expect(host.units["ssh.service"]!.active).toBe("inactive");
    });

    it("applies the rule to the names the host reports, so an alias cannot bypass it", async () => {
      const err = await expectAppError(runSystemdAction(1, "dbus-org.freedesktop.resolve1.service", "stop", ctx), "FORBIDDEN", 403);
      expect(err.message).toMatch(/systemd-resolved\.service.*server:sudo/);
      // Only the resolve script reached the host; the action never ran.
      expect(host.scripts).toHaveLength(1);
      expect(host.scripts[0]).toContain("-p Id,Names,LoadState");
      expect(host.units["systemd-resolved.service"]!.active).toBe("active");
    });

    it("an alias of an ordinary unit is fine", async () => {
      expect((await runSystemdAction(1, "web.service", "stop", ctx)).ok).toBe(true);
    });
  });
});

describe("action audit", () => {
  let mark = 0;
  beforeEach(async () => {
    mark = (await prisma.auditLog.aggregate({ _max: { id: true } }))._max.id ?? 0;
  });
  const actionRows = () =>
    prisma.auditLog.findMany({ where: { action: "server.systemd_action", id: { gt: mark } }, orderBy: { id: "asc" } });
  /** The resolve step answers normally; the action script gets `res`. */
  const actionReturns = (res: ReturnType<typeof result>) =>
    mocks.execAsRoot.mockImplementation(async (client: unknown, script: string) => (/^A='/m.test(script) ? res : fakeExec(client, script)));

  it("a clean run writes exactly one row, outcome succeeded", async () => {
    await runSystemdAction(1, "nginx.service", "restart", ctx);
    const rows = await actionRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.afterJson!)).toMatchObject({ outcome: "succeeded", ok: true, exitCode: 0 });
    expect(JSON.parse(rows[0]!.afterJson!)).not.toHaveProperty("errorCode");
  });

  it("a timeout after the script started writes one row, outcome unknown, and still throws 504", async () => {
    // systemctl was still blocking when the run was killed: only BEFORE made it out.
    actionReturns(result(block("BEFORE", showState("nginx.service")), { exitCode: 124, timedOut: true, errorCode: "TIMEOUT", errorMessage: "The script did not finish within 150s" }));
    const err = await runSystemdAction(1, "nginx.service", "restart", ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteFailureError);
    expect(systemdErrorToHttp(err)).toMatchObject({ status: 504, code: "TIMEOUT" });
    const rows = await actionRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.afterJson!)).toMatchObject({
      unit: "nginx.service",
      action: "restart",
      outcome: "unknown",
      ok: false,
      exitCode: null,
      errorCode: "TIMEOUT",
      error: "The script did not finish within 150s",
    });
    expect(JSON.parse(rows[0]!.beforeJson!)).toMatchObject({ unit: "nginx.service", activeState: "active" });
    expect(clientEnd).toHaveBeenCalled();
  });

  it("output cut short before END (dropped channel) writes outcome unknown and throws 502", async () => {
    actionReturns(result(`${block("BEFORE", showState("nginx.service"))}===RC===\n`, { exitCode: null }));
    const err = await runSystemdAction(1, "nginx.service", "stop", ctx, { canSudo: true }).catch((e: unknown) => e);
    expect(systemdErrorToHttp(err)).toMatchObject({ status: 502, code: "SYSTEMD_HOST_ERROR" });
    const rows = await actionRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.afterJson!)).toMatchObject({ outcome: "unknown", errorCode: "SYSTEMD_HOST_ERROR", exitCode: null });
  });

  it("a host without systemd records the attempt as failed (the prelude bailed out)", async () => {
    host.systemd = false;
    await expectAppError(runSystemdAction(1, "nginx.service", "restart", ctx, { canSudo: true }), "CONFLICT", 409);
    const rows = await actionRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.afterJson!)).toMatchObject({ outcome: "failed", errorCode: "CONFLICT" });
  });

  it("writes no row for refusals and failures before the action script reached the host", async () => {
    // Validation and the static protected-unit rule: no SSH at all.
    await expectAppError(runSystemdAction(1, "$(reboot).service", "restart", ctx, { canSudo: true }), "VALIDATION_ERROR", 400);
    await expectAppError(runSystemdAction(1, "sshd.service", "stop", ctx), "FORBIDDEN", 403);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
    // The alias rule: only the resolve script ran.
    await expectAppError(runSystemdAction(1, "dbus-org.freedesktop.resolve1.service", "stop", ctx), "FORBIDDEN", 403);
    // sudo refused and no channel: the action script never started.
    actionReturns(result("", { exitCode: null, errorCode: "SUDO_AUTH_FAILED", errorMessage: "wrong password" }));
    expect(await runSystemdAction(1, "nginx.service", "restart", ctx).catch((e: unknown) => e)).toBeInstanceOf(RemoteFailureError);
    actionReturns(result("", { exitCode: null, errorCode: "UPLOAD_FAILED", errorMessage: "no channel" }));
    expect(await runSystemdAction(1, "nginx.service", "restart", ctx, { canSudo: true }).catch((e: unknown) => e)).toBeInstanceOf(RemoteFailureError);
    // SSH connect failed.
    mocks.connectToServer.mockRejectedValueOnce(new SshError("unreachable", "down"));
    expect(await runSystemdAction(1, "nginx.service", "restart", ctx, { canSudo: true }).catch((e: unknown) => e)).toBeInstanceOf(SshError);
    expect(await actionRows()).toHaveLength(0);
    expect(host.units["systemd-resolved.service"]!.active).toBe("active");
  });
});

describe("failure mapping", () => {
  it("maps a vault-locked sudo failure to 409 VAULT_LOCKED", async () => {
    mocks.connectToServer.mockResolvedValue({
      client: { end: clientEnd },
      target: { id: 1, hostname: "web-1.example.com", ip: "192.0.2.1", username: "deploy", sshPort: 22 },
      passwordUnavailable: "vault_locked",
    });
    mocks.execAsRoot.mockResolvedValue(result("", { exitCode: null, errorCode: "SUDO_PASSWORD_REQUIRED", errorMessage: "sudo needs a password" }));
    const err = await runSystemdAction(1, "nginx.service", "restart", ctx, { canSudo: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteFailureError);
    expect(systemdErrorToHttp(err)).toMatchObject({ status: 409, code: "VAULT_LOCKED" });
    expect(clientEnd).toHaveBeenCalled();
  });

  it("maps an upload failure to 503 and a timeout to 504", async () => {
    mocks.execPreferRoot.mockResolvedValue({ ...result("", { exitCode: null, errorCode: "UPLOAD_FAILED", errorMessage: "no channel" }), ranAsRoot: true });
    expect(systemdErrorToHttp(await listSystemdUnits(1, { type: "service" }).catch((e: unknown) => e))).toMatchObject({ status: 503, code: "UNREACHABLE" });
    mocks.execAsRoot.mockResolvedValue(result("", { exitCode: 124, timedOut: true, errorCode: "TIMEOUT", errorMessage: "slow" }));
    expect(systemdErrorToHttp(await runSystemdAction(1, "nginx.service", "restart", ctx, { canSudo: true }).catch((e: unknown) => e))).toMatchObject({
      status: 504,
      code: "TIMEOUT",
    });
  });

  it("maps SSH errors, keeping 404 for a missing server", () => {
    expect(systemdErrorToHttp(new SshError("not_found", "Server not found"))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(systemdErrorToHttp(new SshError("vault_locked", "locked"))).toMatchObject({ status: 409, code: "VAULT_LOCKED" });
    expect(systemdErrorToHttp(new SshError("unreachable", "down"))).toMatchObject({ status: 503, code: "SSH_ERROR" });
  });

  it("refuses incomplete host output with 502", async () => {
    mocks.execPreferRoot.mockResolvedValue({ ...result("===UNITS===\n"), ranAsRoot: true });
    expect(systemdErrorToHttp(await listSystemdUnits(1, { type: "service" }).catch((e: unknown) => e))).toMatchObject({
      status: 502,
      code: "SYSTEMD_HOST_ERROR",
    });
  });
});
