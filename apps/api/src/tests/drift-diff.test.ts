import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriftSnapshotData } from "@inv/shared";

/**
 * The pure half of drift detection: parsing the snapshot script's output,
 * canonical hashing, and the snapshot-vs-baseline diff with its severity rules.
 */

const { canonicalJson, diffSnapshots, snapshotHash, sudoersSubjects, MAX_ITEMS_PER_LIST } = await import(
  "../services/drift-diff.js"
);
const {
  parseAuthorizedKeys,
  parseDriftOutput,
  parsePasswd,
  parsePorts,
  parseSudoers,
  parseUnits,
  buildGroups,
  parseGroupFile,
  sshKeyFingerprint,
  DriftCollectError,
  DRIFT_SCRIPT,
} = await import("../services/drift-collect.js");
const { escapeShellArg } = await import("../services/shell-escape.js");

// Throwaway public keys; the fingerprints are what `ssh-keygen -lf` printed for them.
const OPS_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFT39dUGJD8gU3dDiRMLIq/xfkgS9edCcupNym+2B/3T ops@example.com";
const OPS_FP = "SHA256:SwOF5iK153207unrv6b6ak9+KmciV33bdU0vwQergdw";
const INTRUDER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHpc1EzfTaQA8EmLd6/40bUwN5xOoJOBSrEwc2FOgt1l intruder@example.com";
const INTRUDER_FP = "SHA256:5l28XdnWBRWawAlkkUyVHPiucQl92iDZdgrn3cwsQhE";

function base(): DriftSnapshotData {
  return {
    v: 1,
    ranAsRoot: true,
    users: [
      { name: "alice", uid: 1000, gid: 1000, home: "/home/alice", shell: "/bin/bash" },
      { name: "bob", uid: 1001, gid: 1001, home: "/home/bob", shell: "/bin/bash" },
      { name: "root", uid: 0, gid: 0, home: "/root", shell: "/bin/bash" },
    ],
    groups: { sudo: { gid: 27, members: ["alice"] }, docker: { gid: 998, members: [] } },
    sudoers: ["%sudo ALL=(ALL:ALL) ALL", "root ALL=(ALL:ALL) ALL"],
    crontabs: { system: "a".repeat(64), "user:alice": "b".repeat(64) },
    ports: [
      { proto: "tcp", local: "0.0.0.0:22", process: "sshd" },
      { proto: "tcp", local: "127.0.0.1:5432", process: "postgres" },
    ],
    units: ["cron.service", "ssh.service"],
    authorizedKeys: { alice: [{ fp: OPS_FP, type: "ssh-ed25519", comment: "ops@example.com" }] },
    unavailable: {},
    warnings: [],
  };
}

const clone = (d: DriftSnapshotData): DriftSnapshotData => JSON.parse(JSON.stringify(d));

describe("canonical hash", () => {
  it("does not depend on object key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
    const a = base();
    const b = clone(a);
    b.crontabs = { "user:alice": "b".repeat(64), system: "a".repeat(64) };
    b.groups = { docker: { members: [], gid: 998 }, sudo: { members: ["alice"], gid: 27 } };
    expect(snapshotHash(b)).toBe(snapshotHash(a));
  });

  it("ignores scan metadata but not content", () => {
    const a = base();
    const meta = clone(a);
    meta.ranAsRoot = false;
    meta.warnings = ["something"];
    expect(snapshotHash(meta)).toBe(snapshotHash(a));
    const content = clone(a);
    content.units = [...content.units!, "nginx.service"];
    expect(snapshotHash(content)).not.toBe(snapshotHash(a));
  });

  it("an identical snapshot has no drift", () => {
    expect(diffSnapshots(base(), base()).categories).toEqual({});
  });
});

describe("severity rules", () => {
  it("users: new uid-0 account is critical, new account warning, removal info", () => {
    const cur = base();
    cur.users = [
      ...cur.users!.filter((u) => u.name !== "bob"),
      { name: "toor", uid: 0, gid: 0, home: "/root", shell: "/bin/sh" },
      { name: "carol", uid: 1002, gid: 1002, home: "/home/carol", shell: "/bin/bash" },
    ];
    const d = diffSnapshots(base(), cur).categories.users!;
    expect(d.severity).toBe("critical");
    expect(d.changes.added.find((i) => i.key === "toor")?.severity).toBe("critical");
    expect(d.changes.added.find((i) => i.key === "carol")?.severity).toBe("warning");
    expect(d.changes.removed).toMatchObject([{ key: "bob", severity: "info" }]);
    expect(d.summary).toMatch(/User accounts: 2 added, 1 removed/);
  });

  it("users: an existing account changed to uid 0 is critical, other changes warning", () => {
    const cur = base();
    cur.users = cur.users!.map((u) => (u.name === "bob" ? { ...u, uid: 0 } : u.name === "alice" ? { ...u, shell: "/bin/zsh" } : u));
    const d = diffSnapshots(base(), cur).categories.users!;
    expect(d.changes.changed.find((i) => i.key === "bob")?.severity).toBe("critical");
    expect(d.changes.changed.find((i) => i.key === "alice")).toMatchObject({ severity: "warning", label: expect.stringContaining("shell /bin/bash → /bin/zsh") });
  });

  it("groups: a new privileged-group member is critical, removal info", () => {
    const cur = base();
    cur.groups = { sudo: { gid: 27, members: [] }, docker: { gid: 998, members: ["bob"] } };
    const d = diffSnapshots(base(), cur).categories.groups!;
    expect(d.severity).toBe("critical");
    expect(d.changes.added).toMatchObject([{ key: "docker:bob", severity: "critical" }]);
    expect(d.changes.removed).toMatchObject([{ key: "sudo:alice", severity: "info" }]);
  });

  it("sudoers: a new rule is critical, a removed one info", () => {
    const cur = base();
    cur.sudoers = ["%sudo ALL=(ALL:ALL) ALL", "bob ALL=(ALL) NOPASSWD: ALL"];
    const d = diffSnapshots(base(), cur).categories.sudoers!;
    expect(d.severity).toBe("critical");
    expect(d.changes.added).toMatchObject([{ key: "bob ALL=(ALL) NOPASSWD: ALL", severity: "critical" }]);
    expect(d.changes.removed).toMatchObject([{ key: "root ALL=(ALL:ALL) ALL", severity: "info" }]);
  });

  it("crontabs: changed or added is a warning, removed info", () => {
    const cur = base();
    cur.crontabs = { system: "c".repeat(64), "crond:backup": "d".repeat(64) };
    const d = diffSnapshots(base(), cur).categories.crontabs!;
    expect(d.severity).toBe("warning");
    expect(d.changes.changed).toMatchObject([{ key: "system", label: "/etc/crontab changed", severity: "warning" }]);
    expect(d.changes.added).toMatchObject([{ key: "crond:backup", severity: "warning" }]);
    expect(d.changes.removed).toMatchObject([{ key: "user:alice", label: "crontab of alice removed", severity: "info" }]);
  });

  it("ports: a new listening port is a warning, a closed one info, a process swap a warning", () => {
    const cur = base();
    cur.ports = [
      { proto: "tcp", local: "0.0.0.0:22", process: "dropbear" },
      { proto: "tcp", local: "0.0.0.0:8080", process: "python3" },
    ];
    const d = diffSnapshots(base(), cur).categories.ports!;
    expect(d.changes.added).toMatchObject([{ key: "tcp 0.0.0.0:8080", severity: "warning" }]);
    expect(d.changes.removed).toMatchObject([{ key: "tcp 127.0.0.1:5432", severity: "info" }]);
    expect(d.changes.changed).toMatchObject([{ key: "tcp 0.0.0.0:22", severity: "warning" }]);
  });

  it("ports: a scan that cannot see process names reports no process change", () => {
    const cur = base();
    cur.ports = cur.ports!.map((p) => ({ ...p, process: null }));
    expect(diffSnapshots(base(), cur).categories.ports).toBeUndefined();
  });

  it("units: enabled and disabled units are info", () => {
    const cur = base();
    cur.units = ["cron.service", "nginx.service"];
    const d = diffSnapshots(base(), cur).categories.units!;
    expect(d.severity).toBe("info");
    expect(d.changes.added).toMatchObject([{ key: "nginx.service", severity: "info" }]);
    expect(d.changes.removed).toMatchObject([{ key: "ssh.service", severity: "info" }]);
  });

  it("authorized_keys: a new key for root is critical", () => {
    const cur = base();
    cur.authorizedKeys = { ...cur.authorizedKeys!, root: [{ fp: INTRUDER_FP, type: "ssh-ed25519", comment: "intruder@example.com" }] };
    const d = diffSnapshots(base(), cur).categories.authorized_keys!;
    expect(d.severity).toBe("critical");
    expect(d.changes.added).toMatchObject([{ key: `root ${INTRUDER_FP}`, severity: "critical" }]);
  });

  it("authorized_keys: privileged via group or sudoers is critical, an ordinary user warning", () => {
    const cur = base();
    // alice is in sudo; bob is not privileged; carol gets a direct sudoers rule.
    cur.users = [...cur.users!, { name: "carol", uid: 1002, gid: 1002, home: "/home/carol", shell: "/bin/bash" }];
    cur.sudoers = [...cur.sudoers!, "carol ALL=(ALL) /usr/bin/systemctl"];
    const key = { fp: INTRUDER_FP, type: "ssh-ed25519", comment: "" };
    cur.authorizedKeys = { alice: [...cur.authorizedKeys!.alice!, key], bob: [key], carol: [key] };
    const d = diffSnapshots(base(), cur).categories.authorized_keys!;
    const sev = (user: string) => d.changes.added.find((i) => i.key === `${user} ${INTRUDER_FP}`)?.severity;
    expect(sev("alice")).toBe("critical");
    expect(sev("carol")).toBe("critical");
    expect(sev("bob")).toBe("warning");
  });

  it("authorized_keys: a removed key is info", () => {
    const cur = base();
    cur.authorizedKeys = {};
    const d = diffSnapshots(base(), cur).categories.authorized_keys!;
    expect(d.severity).toBe("info");
    expect(d.changes.removed).toMatchObject([{ key: `alice ${OPS_FP}`, severity: "info" }]);
  });
});

describe("unavailable categories", () => {
  it("are skipped, never reported as removed", () => {
    const cur = base();
    cur.ranAsRoot = false;
    cur.sudoers = null;
    cur.crontabs = null;
    cur.authorizedKeys = null;
    cur.unavailable = { sudoers: "needs root", crontabs: "needs root", authorized_keys: "needs root" };
    const d = diffSnapshots(base(), cur);
    expect(d.categories).toEqual({});
    expect(Object.keys(d.skipped).sort()).toEqual(["authorized_keys", "crontabs", "sudoers"]);
    expect(d.skipped.sudoers).toMatch(/not collected in this scan \(needs root\)/);
  });

  it("are skipped when the baseline lacked them", () => {
    const b = base();
    b.sudoers = null;
    const cur = base();
    cur.sudoers = [...cur.sudoers!, "bob ALL=(ALL) ALL"];
    const d = diffSnapshots(b, cur);
    expect(d.categories.sudoers).toBeUndefined();
    expect(d.skipped.sudoers).toMatch(/baseline/);
  });

  it("a sudoers-only group missing from a scan without sudoers is not 'removed'", () => {
    const b = base();
    b.groups = { ...b.groups!, ops: { gid: 2000, members: ["bob"] } };
    b.sudoers = [...b.sudoers!, "%ops ALL=(ALL) ALL"];
    const cur = base();
    cur.sudoers = null;
    cur.unavailable = { sudoers: "needs root" };
    expect(diffSnapshots(b, cur).categories.groups).toBeUndefined();
  });

  it("caps long change lists and counts the rest", () => {
    const cur = base();
    cur.units = Array.from({ length: MAX_ITEMS_PER_LIST + 5 }, (_, i) => `u${String(i).padStart(4, "0")}.service`);
    const d = diffSnapshots(base(), cur).categories.units!;
    expect(d.changes.added).toHaveLength(MAX_ITEMS_PER_LIST);
    expect(d.changes.omitted).toBe(5);
  });
});

describe("parsers", () => {
  it("fingerprints authorized keys exactly like ssh-keygen -lf, options included", () => {
    expect(sshKeyFingerprint(OPS_KEY.split(" ")[1]!)).toBe(OPS_FP);
    const keys = parseAuthorizedKeys(
      [
        "# comment",
        "",
        OPS_KEY,
        // A quoted option that itself looks like a key must not hide the real one.
        `command="echo ssh-rsa AAAA hi",no-pty ${INTRUDER_KEY}`,
        "garbage that is not a key",
      ].join("\n"),
    );
    expect(keys.map((k) => k.fp)).toEqual(expect.arrayContaining([OPS_FP, INTRUDER_FP]));
    expect(keys.find((k) => k.fp === INTRUDER_FP)?.comment).toBe("intruder@example.com");
    expect(keys.find((k) => k.fp.startsWith("LINE:"))?.type).toBe("unparsed");
  });

  it("normalizes sudoers: strips comments, blanks and Defaults, keeps #include, joins continuations", () => {
    const rules = parseSudoers(
      [
        "# a comment",
        "Defaults env_reset",
        "Defaults:bob !authenticate",
        "",
        "root\tALL=(ALL:ALL)   ALL",
        "#includedir /etc/sudoers.d",
        "bob ALL=(ALL) \\",
        "   /usr/bin/systemctl",
        "root ALL=(ALL:ALL) ALL",
      ].join("\n"),
    );
    expect(rules).toEqual(["#includedir /etc/sudoers.d", "bob ALL=(ALL) /usr/bin/systemctl", "root ALL=(ALL:ALL) ALL"]);
    const subj = sudoersSubjects(["%admins ALL=(ALL) ALL", "User_Alias OPS = dave, %wheel", "erin,frank ALL=(ALL) ALL"]);
    expect([...subj.groups].sort()).toEqual(["admins", "wheel"]);
    expect([...subj.users].sort()).toEqual(["dave", "erin", "frank"]);
  });

  it("parses ss output: strips pids, collapses ephemeral ports, drops process names without root", () => {
    const ss = [
      "Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      'tcp   LISTEN 0      4096   0.0.0.0:22         0.0.0.0:*         users:(("sshd",pid=812,fd=3))',
      'tcp   LISTEN 0      4096   [::]:22            [::]:*            users:(("sshd",pid=812,fd=4))',
      'udp   UNCONN 0      0      0.0.0.0:47113      0.0.0.0:*         users:(("avahi-daemon",pid=9,fd=14))',
      'udp   UNCONN 0      0      0.0.0.0:51820      0.0.0.0:*         users:(("avahi-daemon",pid=9,fd=15))',
      'udp   UNCONN 0      0      127.0.0.53%lo:53   0.0.0.0:*         users:(("systemd-resolve",pid=5,fd=13))',
    ].join("\n");
    expect(parsePorts(ss, true)).toEqual([
      { proto: "tcp", local: "0.0.0.0:22", process: "sshd" },
      { proto: "tcp", local: "[::]:22", process: "sshd" },
      { proto: "udp", local: "0.0.0.0:ephemeral", process: "avahi-daemon" },
      { proto: "udp", local: "127.0.0.53%lo:53", process: "systemd-resolve" },
    ]);
    expect(parsePorts(ss, false).every((p) => p.process === null)).toBe(true);
  });

  it("parses passwd, groups (with primary members) and units", () => {
    const users = parsePasswd("root:x:0:0:root:/root:/bin/bash\n+nis\nbob:x:1001:27:Bob,,,:/home/bob:/bin/bash\n");
    expect(users.map((u) => u.name)).toEqual(["bob", "root"]);
    const groups = buildGroups(parseGroupFile("sudo:x:27:alice\nops:x:2000:carol\nusers:x:100:\n"), users, ["%ops ALL=(ALL) ALL"]);
    expect(groups).toEqual({ ops: { gid: 2000, members: ["carol"] }, sudo: { gid: 27, members: ["alice", "bob"] } });
    expect(parseUnits("ssh.service enabled enabled\ncron.service enabled enabled\ngarbage\n")).toEqual(["cron.service", "ssh.service"]);
  });

  it("the real script runs under /bin/sh and its output parses (stubbed commands, temp homes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rackmap-drift-"));
    try {
      mkdirSync(join(dir, "root/.ssh"), { recursive: true });
      mkdirSync(join(dir, "ops/.ssh"), { recursive: true });
      writeFileSync(join(dir, "root/.ssh/authorized_keys"), `${INTRUDER_KEY}\n`);
      writeFileSync(join(dir, "ops/.ssh/authorized_keys"), `# managed\n${OPS_KEY}\n`);
      const stubs = [
        `T=${escapeShellArg(dir)}`,
        "id() { echo 0; }",
        `getent() { case "$1" in passwd) printf 'root:x:0:0:root:%s/root:/bin/sh\\nops:x:1000:1000::%s/ops:/bin/sh\\nweird name:x:1001:1001::/tmp:/bin/sh\\n' "$T" "$T" ;; group) printf 'root:x:0:\\nsudo:x:27:ops\\n' ;; esac; }`,
        `ss() { printf 'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))\\n'; }`,
        "systemctl() { printf 'ssh.service enabled enabled\\n'; }",
      ].join("\n");
      const stdout = execFileSync("/bin/sh", ["-c", `${stubs}\n${DRIFT_SCRIPT}`], { encoding: "utf8" });
      const data = parseDriftOutput(stdout);
      expect(data.ranAsRoot).toBe(true);
      expect(data.users?.map((u) => u.name)).toEqual(["ops", "root", "weird name"]);
      expect(data.groups?.sudo?.members).toEqual(["ops"]);
      expect(data.ports).toEqual([{ proto: "tcp", local: "0.0.0.0:22", process: "sshd" }]);
      expect(data.units).toEqual(["ssh.service"]);
      expect(data.sudoers).not.toBeNull();
      expect(data.crontabs).not.toBeNull();
      expect(data.authorizedKeys).toEqual({
        ops: [{ fp: OPS_FP, type: "ssh-ed25519", comment: "ops@example.com" }],
        root: [{ fp: INTRUDER_FP, type: "ssh-ed25519", comment: "intruder@example.com" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses output that did not reach END", () => {
    expect(() => parseDriftOutput("===ROOT===\n1\n===PASSWD===\ncm9vdDp4OjA6MDo6L3Jvb3Q6L2Jpbi9zaAo=\n")).toThrow(DriftCollectError);
  });
});
