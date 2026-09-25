import { describe, it, expect } from "vitest";
import {
  isCriticalSystemdUnit,
  isProtectedSystemdUnit,
  isValidJournalSince,
  isValidSystemdUnitName,
  journalSinceArg,
  SystemdLogsQuery,
  SystemdUnitName,
  systemdActionNeedsSudo,
} from "@inv/shared";
import {
  hostUnitNames,
  mergeSystemdUnits,
  parseListUnitFiles,
  parseListUnits,
  parseShow,
  parseSystemdBlocks,
  parseSystemdListOutput,
  readSystemdActionOutput,
  remoteScriptStarted,
  systemdActionOutcome,
  toUnitDetails,
} from "../services/systemd.service.js";

/** Output parsers of the systemd service manager, against captured-style fixtures. */

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// `systemctl list-units --all --no-pager --plain --no-legend --full` (padded columns, as systemd prints them)
const LIST_UNITS = [
  "accounts-daemon.service                        loaded    active   running Accounts Service",
  "apparmor.service                               loaded    active   exited  Load AppArmor profiles",
  "cron.service                                   loaded    active   running Regular background program processing daemon",
  "getty@tty1.service                             loaded    active   running Getty on tty1",
  "nginx.service                                  loaded    failed   failed  A high performance web server and a reverse proxy server",
  "ntp.service                                    not-found inactive dead    ntp.service",
  "postgresql@18-main.service                     loaded    active   running PostgreSQL Cluster 18-main",
  "snapd.service                                  masked    inactive dead    snapd.service",
  "ssh.service                                    loaded    active   running OpenBSD Secure Shell server",
  "  weird-spacing.service   loaded   activating    start-pre    Description   with   inner   spaces   ",
  // Older systemd without --plain support prints a bullet in front of failed units.
  "● legacy-failed.service loaded failed failed Legacy thing",
  "dev-disk-by\\x2duuid-0f3c.swap loaded active active /dev/disk/by-uuid/0f3c",
  "",
].join("\n");

// `systemctl list-unit-files --no-legend` (newer systemd adds the VENDOR PRESET column)
const LIST_UNIT_FILES = [
  "accounts-daemon.service                    enabled         enabled",
  "apparmor.service                           enabled         enabled",
  "cron.service                               enabled         enabled",
  "getty@.service                             enabled         enabled",
  "nginx.service                              enabled         enabled",
  "postgresql@.service                        indirect        enabled",
  "snapd.service                              masked          enabled",
  "ssh.service                                enabled         enabled",
  "sshd.service                               alias           -",
  "rsync.service                              disabled        enabled",
  "systemd-networkd.service                   disabled        enabled",
  "ssh.socket                                 disabled        enabled",
  "",
].join("\n");

// systemd 219 (CentOS 7): two columns only.
const LIST_UNIT_FILES_OLD = ["crond.service                               enabled", "tuned.service   disabled", "garbage", ""].join("\n");

describe("parseListUnits", () => {
  const rows = parseListUnits(LIST_UNITS);

  it("parses padded columns and keeps the description's inner spacing", () => {
    const nginx = rows.find((r) => r.unit === "nginx.service");
    expect(nginx).toEqual({
      unit: "nginx.service",
      load: "loaded",
      active: "failed",
      sub: "failed",
      description: "A high performance web server and a reverse proxy server",
    });
    const weird = rows.find((r) => r.unit === "weird-spacing.service");
    expect(weird).toMatchObject({ load: "loaded", active: "activating", sub: "start-pre", description: "Description   with   inner   spaces" });
  });

  it("handles templated units, not-found and masked units", () => {
    expect(rows.find((r) => r.unit === "getty@tty1.service")?.description).toBe("Getty on tty1");
    expect(rows.find((r) => r.unit === "postgresql@18-main.service")?.active).toBe("active");
    expect(rows.find((r) => r.unit === "ntp.service")).toMatchObject({ load: "not-found", active: "inactive", sub: "dead" });
    expect(rows.find((r) => r.unit === "snapd.service")?.load).toBe("masked");
  });

  it("strips a leading bullet", () => {
    expect(rows.find((r) => r.unit === "legacy-failed.service")).toMatchObject({ load: "loaded", active: "failed" });
  });

  it("skips legend lines and headers when --no-legend is not honoured", () => {
    const withLegend = [
      "UNIT          LOAD   ACTIVE SUB     DESCRIPTION",
      "ssh.service   loaded active running OpenBSD Secure Shell server",
      "",
      "LOAD   = Reflects whether the unit definition was properly loaded.",
      "ACTIVE = The high-level unit activation state, i.e. generalization of SUB.",
      "",
      "1 loaded units listed.",
      "To show all installed unit files use 'systemctl list-unit-files'.",
    ].join("\n");
    expect(parseListUnits(withLegend).map((r) => r.unit)).toEqual(["ssh.service"]);
  });

  it("handles CRLF line endings", () => {
    expect(parseListUnits("ssh.service loaded active running SSH\r\n")[0]?.description).toBe("SSH");
  });
});

describe("parseListUnitFiles", () => {
  it("reads the state with and without the vendor preset column", () => {
    const files = parseListUnitFiles(LIST_UNIT_FILES);
    expect(files.get("nginx.service")).toBe("enabled");
    expect(files.get("snapd.service")).toBe("masked");
    expect(files.get("postgresql@.service")).toBe("indirect");
    expect(files.get("sshd.service")).toBe("alias");
    const old = parseListUnitFiles(LIST_UNIT_FILES_OLD);
    expect(old.get("crond.service")).toBe("enabled");
    expect(old.get("tuned.service")).toBe("disabled");
    expect(old.size).toBe(2);
  });

  it("ignores the header and footer", () => {
    const files = parseListUnitFiles("UNIT FILE     STATE   VENDOR PRESET\nssh.service enabled enabled\n\n1 unit files listed.\n");
    expect([...files.keys()]).toEqual(["ssh.service"]);
  });
});

describe("mergeSystemdUnits", () => {
  const merged = mergeSystemdUnits(parseListUnits(LIST_UNITS), parseListUnitFiles(LIST_UNIT_FILES), ["service"]);
  const get = (u: string) => merged.find((m) => m.unit === u);

  it("adds enablement from the unit files, falling back to the template for instances", () => {
    expect(get("nginx.service")?.enabled).toBe("enabled");
    expect(get("getty@tty1.service")?.enabled).toBe("enabled");
    expect(get("postgresql@18-main.service")?.enabled).toBe("indirect");
    expect(get("snapd.service")?.enabled).toBe("masked");
    expect(get("ntp.service")?.enabled).toBeNull();
  });

  it("lists installed but unloaded unit files, never bare templates", () => {
    expect(get("rsync.service")).toEqual({
      unit: "rsync.service",
      load: "not-loaded",
      active: "inactive",
      sub: "dead",
      description: "",
      enabled: "disabled",
    });
    expect(get("getty@.service")).toBeUndefined();
    expect(get("postgresql@.service")).toBeUndefined();
    // An alias row would duplicate the unit it points to.
    expect(get("sshd.service")).toBeUndefined();
  });

  it("filters by type and sorts by name", () => {
    expect(merged.some((m) => m.unit.endsWith(".socket") || m.unit.endsWith(".swap"))).toBe(false);
    const names = merged.map((m) => m.unit);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const sockets = mergeSystemdUnits([], parseListUnitFiles(LIST_UNIT_FILES), ["socket"]);
    expect(sockets.map((s) => s.unit)).toEqual(["ssh.socket"]);
  });
});

describe("parseSystemdListOutput", () => {
  it("decodes the marker/base64 protocol", () => {
    const out = `===UNITS===\n${b64(LIST_UNITS)}\n===FILES===\n${b64(LIST_UNIT_FILES)}\n===END===\n`;
    const res = parseSystemdListOutput(out, "service");
    expect(res.supported).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.units.find((u) => u.unit === "ssh.service")?.enabled).toBe("enabled");
  });

  it("reports a host without systemd as unsupported", () => {
    expect(parseSystemdListOutput("===NOSYSTEMD===\n===END===\n", "all")).toEqual({ supported: false, units: [], truncated: false });
  });

  it("refuses incomplete output", () => {
    expect(() => parseSystemdListOutput(`===UNITS===\n${b64(LIST_UNITS)}\n`, "service")).toThrow(/Incomplete/);
  });

  it("a marker lookalike inside host output cannot inject a block", () => {
    const hostile = "evil.service loaded active running x\n===NOSYSTEMD===\n===END===\n";
    const out = `===UNITS===\n${b64(hostile)}\n===FILES===\n${b64("")}\n===END===\n`;
    const res = parseSystemdListOutput(out, "service");
    expect(res.supported).toBe(true);
    expect(res.units.map((u) => u.unit)).toEqual(["evil.service"]);
    expect(parseSystemdBlocks(out).map((b) => b.kind)).toEqual(["UNITS", "FILES", "END"]);
  });
});

describe("parseShow / toUnitDetails", () => {
  const SHOW = [
    "Id=nginx.service",
    "Description=A high performance web server and a reverse proxy server",
    "LoadState=loaded",
    "ActiveState=active",
    "SubState=running",
    "UnitFileState=enabled",
    "MainPID=1234",
    "ExecMainStartTimestamp=Fri 2026-09-25 10:00:00 UTC",
    "MemoryCurrent=18874368",
    "FragmentPath=/lib/systemd/system/nginx.service",
    "Restart=on-failure",
    "NRestarts=2",
    "Environment=A=1 B=2",
    "",
  ].join("\n");

  it("splits at the first '=' only", () => {
    expect(parseShow(SHOW)["Environment"]).toBe("A=1 B=2");
  });

  it("maps properties to the DTO", () => {
    const d = toUnitDetails("nginx.service", parseShow(SHOW), "2026-09-25T10:00:00+0000 web-1 nginx[1234]: started\n", true);
    expect(d).toEqual({
      unit: "nginx.service",
      id: "nginx.service",
      description: "A high performance web server and a reverse proxy server",
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      mainPid: 1234,
      startedAt: "Fri 2026-09-25 10:00:00 UTC",
      memoryBytes: 18874368,
      fragmentPath: "/lib/systemd/system/nginx.service",
      restart: "on-failure",
      nRestarts: 2,
      journal: ["2026-09-25T10:00:00+0000 web-1 nginx[1234]: started"],
      ranAsRoot: true,
    });
  });

  it("treats unset values as null (stopped unit, no memory accounting, old systemd without NRestarts)", () => {
    const d = toUnitDetails(
      "foo.service",
      parseShow(
        "Id=foo.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=\nMainPID=0\nExecMainStartTimestamp=\nMemoryCurrent=[not set]\nFragmentPath=\nRestart=no\n",
      ),
      "",
      false,
    );
    expect(d).toMatchObject({ mainPid: null, startedAt: null, memoryBytes: null, fragmentPath: null, unitFileState: null, nRestarts: null, journal: [], ranAsRoot: false });
    expect(toUnitDetails("x.service", parseShow("MemoryCurrent=18446744073709551615\n"), "", true).memoryBytes).toBeNull();
  });

  it("collects every host name of a unit for the alias check", () => {
    const show = parseShow("Id=systemd-resolved.service\nNames=systemd-resolved.service dbus-org.freedesktop.resolve1.service\nLoadState=loaded\n");
    expect(hostUnitNames(show)).toEqual(["systemd-resolved.service", "dbus-org.freedesktop.resolve1.service"]);
    expect(hostUnitNames(parseShow("Id=a b.service\nNames=$(x).service ok.service\n"))).toEqual(["ok.service"]);
  });
});

describe("readSystemdActionOutput / systemdActionOutcome", () => {
  const block = (header: string, payload: string) => `===${header}===\n${b64(payload)}\n`;
  const BEFORE = block("BEFORE", "Id=nginx.service\nActiveState=active\nSubState=running\n");

  it("reads a complete run", () => {
    const run = readSystemdActionOutput(`${BEFORE}${block("RC", "0")}${block("OUT", "")}${block("AFTER", "ActiveState=inactive\n")}===END===\n`);
    expect(run).toMatchObject({ skipped: false, exitCode: 0, before: { ActiveState: "active" }, after: { ActiveState: "inactive" } });
    expect(systemdActionOutcome(run)).toBe("succeeded");
  });

  it("a run cut off before systemctl returned has no exit status: unknown", () => {
    // RC's payload line never finished ("MA" of "MA=="), so it is not read.
    const run = readSystemdActionOutput(`${BEFORE}===RC===\nMA`);
    expect(run.exitCode).toBeNull();
    expect(run.before.ActiveState).toBe("active");
    expect(systemdActionOutcome(run)).toBe("unknown");
    expect(systemdActionOutcome(readSystemdActionOutput(""))).toBe("unknown");
  });

  it("once systemctl returned, its exit status decides, even if the rest was lost", () => {
    expect(systemdActionOutcome(readSystemdActionOutput(`${BEFORE}${block("RC", "1")}===OUT===\n`))).toBe("failed");
    expect(systemdActionOutcome(readSystemdActionOutput(`${BEFORE}${block("RC", "0")}`))).toBe("succeeded");
  });

  it("a prelude bail-out means systemctl never ran: failed", () => {
    expect(systemdActionOutcome(readSystemdActionOutput("===NOSYSTEMD===\n===END===\n"))).toBe("failed");
    expect(systemdActionOutcome(readSystemdActionOutput("===FATAL:NO_BASE64===\n"))).toBe("failed");
  });

  it("only a run whose channel opened counts as started", () => {
    const res = (errorCode?: string) => ({ errorCode }) as Parameters<typeof remoteScriptStarted>[0];
    expect(remoteScriptStarted(res())).toBe(true);
    expect(remoteScriptStarted(res("TIMEOUT"))).toBe(true);
    expect(remoteScriptStarted(res("CANCELLED"))).toBe(true);
    for (const code of ["UPLOAD_FAILED", "NO_INTERPRETER", "SUDO_PASSWORD_REQUIRED", "SUDO_AUTH_FAILED", "SUDO_REQUIRETTY", "SUDO_NOT_ALLOWED"]) {
      expect(remoteScriptStarted(res(code))).toBe(false);
    }
  });
});

describe("unit name and since validation (shared)", () => {
  it.each(["nginx.service", "getty@tty1.service", "postgresql@18-main.service", "systemd-networkd.socket", "-.mount", "run-user-1000.mount", "foo:bar.timer", "a.b_c-d.path", "multi-user.target"])(
    "accepts %s",
    (name) => {
      expect(isValidSystemdUnitName(name)).toBe(true);
      expect(SystemdUnitName.safeParse(name).success).toBe(true);
    },
  );

  it.each([
    "nginx",
    "nginx.scope",
    "nginx.device",
    "foo;reboot.service",
    "$(reboot).service",
    "`id`.service",
    "a b.service",
    "a'b.service",
    'a"b.service',
    "../../etc/passwd.service",
    "dev-disk-by\\x2duuid.mount",
    "nginx.service\n",
    "nginx.service\nreboot",
    "--help.service",
    "-x.service",
    "*.service",
    "nginx?.service",
    `${"a".repeat(201)}.service`,
    "",
  ])("rejects %j", (name) => {
    expect(isValidSystemdUnitName(name)).toBe(false);
    expect(SystemdUnitName.safeParse(name).success).toBe(false);
  });

  it("validates and converts since", () => {
    expect(journalSinceArg("1h")).toBe("-1h");
    expect(journalSinceArg("30m")).toBe("-30min");
    expect(journalSinceArg("15min")).toBe("-15min");
    expect(journalSinceArg("7d")).toBe("-7d");
    expect(journalSinceArg("2026-09-25")).toBe("2026-09-25 00:00:00");
    expect(journalSinceArg("2026-09-25T10:00")).toBe("2026-09-25 10:00:00");
    expect(journalSinceArg("2026-09-25 10:00:05")).toBe("2026-09-25 10:00:05");
    expect(journalSinceArg("2026-09-25T10:00:00Z")).toBe(`@${Date.UTC(2026, 8, 25, 10) / 1000}`);
    expect(journalSinceArg("2026-09-25T12:00:00+02:00")).toBe(`@${Date.UTC(2026, 8, 25, 10) / 1000}`);
    for (const bad of ["yesterday", "1 hour", "-1h", "1h; reboot", "2026-13-45T99:99", "$(date)", "1y", ""]) {
      expect(isValidJournalSince(bad)).toBe(false);
      expect(journalSinceArg(bad)).toBeNull();
    }
  });

  it("bounds lines to 1..2000 with a default of 200", () => {
    expect(SystemdLogsQuery.parse({}).lines).toBe(200);
    expect(SystemdLogsQuery.parse({ lines: "2000" }).lines).toBe(2000);
    expect(SystemdLogsQuery.safeParse({ lines: "0" }).success).toBe(false);
    expect(SystemdLogsQuery.safeParse({ lines: "2001" }).success).toBe(false);
    expect(SystemdLogsQuery.safeParse({ lines: "1.5" }).success).toBe(false);
    expect(SystemdLogsQuery.safeParse({ since: "1h; reboot" }).success).toBe(false);
  });
});

describe("protected-unit rule (shared)", () => {
  it.each([
    "ssh.service",
    "sshd.service",
    "ssh.socket",
    "sshd@0-192.0.2.1:22-198.51.100.7:50000.service",
    "dbus.service",
    "dbus.socket",
    "networking.service",
    "NetworkManager.service",
    "systemd-networkd.service",
    "systemd-resolved.service",
    "systemd-journald.socket",
    "cron.service",
    "crond.service",
    "docker.service",
    "docker.socket",
    "containerd.service",
    "kubelet.service",
    "getty@tty1.service",
    "multi-user.target",
    "-.mount",
  ])("%s is protected: stop/restart/disable need sudo, reload does not", (unit) => {
    expect(isProtectedSystemdUnit(unit)).toBe(true);
    for (const a of ["stop", "restart", "disable"] as const) expect(systemdActionNeedsSudo(unit, a)).toBe(true);
    if (!isCriticalSystemdUnit(unit)) {
      expect(systemdActionNeedsSudo(unit, "reload")).toBe(false);
      expect(systemdActionNeedsSudo(unit, "start")).toBe(false);
    }
  });

  it.each(["nginx.service", "postgresql@18-main.service", "sshd-keygen@rsa.service", "my-ssh-tunnel.service", "dockerd-exporter.service", "logrotate.timer"])(
    "%s is not protected",
    (unit) => {
      expect(isProtectedSystemdUnit(unit)).toBe(false);
      for (const a of ["start", "stop", "restart", "reload", "enable", "disable"] as const) expect(systemdActionNeedsSudo(unit, a)).toBe(false);
    },
  );

  it.each(["reboot.target", "poweroff.target", "rescue.target", "systemd-reboot.service", "systemd-poweroff.service", "debug-shell.service", "emergency.service"])(
    "%s needs sudo for every action, including start",
    (unit) => {
      for (const a of ["start", "stop", "restart", "reload", "enable", "disable"] as const) expect(systemdActionNeedsSudo(unit, a)).toBe(true);
    },
  );
});
