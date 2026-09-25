import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * cron.service against a fake host: remote-exec and connectToServer are mocked,
 * and the mock "executes" the generated scripts by recognising their shape and
 * answering in the marker/base64 protocol the real scripts print.
 */

const mocks = vi.hoisted(() => ({
  execAsRoot: vi.fn(),
  connectToServer: vi.fn(),
}));

vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execAsRoot: mocks.execAsRoot };
});
vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});

const {
  buildCronReadAllScript,
  buildCronReadTargetScript,
  buildCronRunScript,
  buildCronWriteScript,
  cronErrorToHttp,
  parseCronReadOutput,
  parseTimers,
  readCronTarget,
  readCronTargets,
  runCronEntry,
  writeCronTarget,
} = await import("../services/cron.service.js");
const { AppError } = await import("../lib/errors.js");
const { escapeShellArg } = await import("../services/shell-escape.js");
const { prisma } = await import("../db.js");
const { PRIVILEGED_OS_GROUPS } = await import("../services/os-user.service.js");
const { SshError } = await import("../services/ssh.service.js");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const block = (header: string, payload?: string) => `===${header}===\n${payload === undefined ? "" : b64(payload) + "\n"}`;

interface FakeHost {
  tz: string;
  users: Record<string, { crontab: string | null; priv: string; exists?: boolean }>;
  system: string | null;
  crond: Record<string, string>;
  timers: string;
  scripts: string[];
}

let host: FakeHost;

const TIMERS = [
  "NEXT                        LEFT          LAST                        PASSED       UNIT                         ACTIVATES",
  "Fri 2026-09-25 18:00:00 UTC 1h 2min left  Fri 2026-09-25 17:00:00 UTC 57min ago    logrotate.timer              logrotate.service",
  "n/a                         n/a           n/a                         n/a          snapd.snap-repair.timer      snapd.snap-repair.service",
  // systemd 255 layout: LEFT and PASSED are right-aligned under their headers.
  "Fri 2026-09-25 22:33:06 UTC    21min Fri 2026-09-25 21:42:59 UTC    28min ago anacron.timer                  anacron.service",
  "-                                  - Thu 2026-09-24 03:10:00 UTC 19h ago   e2scrub_all.timer              e2scrub_all.service",
  "",
  "4 timers listed.",
].join("\n");

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

function userBlocks(name: string): string {
  const u = host.users[name];
  let out = "";
  if (!u || u.exists === false) out += `===NOUSER:${name}===\n`;
  if (u?.crontab != null) out += block(`USER:${name}`, u.crontab);
  out += block(`PRIV:${name}`, u && u.exists !== false ? u.priv : "unknown");
  return out;
}

/** Answer a generated script the way the host would. */
function fakeExec(_client: unknown, script: string) {
  host.scripts.push(script);
  if (script.includes("runuser")) return result("hello from the job\n", { exitCode: 3 });

  const writeMatch = /\[ "\$h" = '([a-f0-9]{64})' \]/.exec(script);
  if (writeMatch) {
    const expected = writeMatch[1];
    const user = /^U='([^']*)'$/m.exec(script)?.[1];
    const file = /^F='([^']*)'$/m.exec(script)?.[1];
    const current = user ? host.users[user]?.crontab ?? "" : file === "/etc/crontab" ? host.system ?? "" : host.crond[file!.replace("/etc/cron.d/", "")] ?? "";
    if (sha(current) !== expected) return result("===CONFLICT===\n", { exitCode: 3 });
    const payload = /printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d/.exec(script)?.[1];
    const deleting = script.includes('rm -f -- "$F"');
    const next = deleting ? "" : Buffer.from(payload ?? "", "base64").toString("utf8");
    if (user) host.users[user] = { ...(host.users[user] ?? { priv: "" }), crontab: next };
    else if (file === "/etc/crontab") host.system = next;
    else if (deleting) delete host.crond[file!.replace("/etc/cron.d/", "")];
    else host.crond[file!.replace("/etc/cron.d/", "")] = next;
    const backup = current ? block("BACKUP", "/var/backups/rackmap-cron/x.20260925T000000Z") : "";
    return result(`${backup}${block("AFTER", next)}===END===\n`);
  }

  let out = block("TZ", host.tz);
  if (script.includes("for d in /var/spool/cron/crontabs /var/spool/cron")) {
    for (const name of Object.keys(host.users)) if (host.users[name]!.crontab != null) out += userBlocks(name);
    if (host.system !== null) out += block("SYSTEM", host.system);
    for (const [f, c] of Object.entries(host.crond)) out += block(`CROND:${f}`, c);
    out += block("TIMERS", host.timers);
  } else {
    const user = /^user_block '([^']*)'$/m.exec(script)?.[1];
    const crond = /^crond_block '([^']*)'$/m.exec(script)?.[1];
    if (user) out += userBlocks(user);
    else if (crond) {
      if (host.crond[crond] !== undefined) out += block(`CROND:${crond}`, host.crond[crond]);
    } else if (/^system_block$/m.test(script) && host.system !== null) out += block("SYSTEM", host.system);
  }
  return result(out + "===END===\n");
}

const ctx = { actorId: null, actorEmail: "editor@example.com", ip: "192.0.2.10" };
const client = { end: vi.fn() };

beforeEach(() => {
  host = {
    tz: "Europe/Berlin",
    users: {
      alice: { crontab: "# alice\n*/5 * * * * /home/alice/poll.sh\n", priv: "" },
      root: { crontab: "0 3 * * * /usr/local/sbin/backup --password=hunter2\n", priv: "uid0" },
      bob: { crontab: "@daily /home/bob/cleanup\n", priv: "group:docker" },
    },
    system: "SHELL=/bin/sh\n17 * * * * root cd / && run-parts --report /etc/cron.hourly\n",
    crond: { "rackmap-report": "0 6 * * * root /opt/report\n", "php.dpkg-old": "09,39 * * * * root /bin/true\n" },
    timers: TIMERS,
    scripts: [],
  };
  mocks.execAsRoot.mockReset().mockImplementation(fakeExec);
  mocks.connectToServer.mockReset().mockResolvedValue({
    client,
    password: "ssh-pw",
    target: { id: 1, hostname: "web-1.example.com", ip: "192.0.2.1", username: "deploy", sshPort: 22 },
  });
});

async function expectAppError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect(err.code).toBe(code);
  expect(err.status).toBe(status);
  return err;
}

describe("readCronTargets", () => {
  it("lists spool users, /etc/crontab, cron.d and timers with sha256 hashes", async () => {
    const snap = await readCronTargets(1);
    expect(snap.timezone).toBe("Europe/Berlin");
    expect(snap.targets.map((t) => t.target)).toEqual([
      { kind: "user", user: "root" },
      { kind: "user", user: "alice" },
      { kind: "user", user: "bob" },
      { kind: "system" },
      { kind: "crond", file: "php.dpkg-old" },
      { kind: "crond", file: "rackmap-report" },
    ]);
    for (const t of snap.targets) expect(t.hash).toBe(sha(t.content));
    expect(snap.targets[1]!.content).toBe(host.users.alice!.crontab);
    expect(client.end).toHaveBeenCalled();
    // One root script, run with the SSH password for sudo.
    expect(mocks.execAsRoot).toHaveBeenCalledTimes(1);
    expect(mocks.execAsRoot.mock.calls[0]![2]).toBe("ssh-pw");
  });

  it("marks privileged users from the host's verdict", async () => {
    const snap = await readCronTargets(1);
    const byUser = Object.fromEntries(
      snap.targets.filter((t) => t.target.kind === "user").map((t) => [(t.target as { user: string }).user, t]),
    );
    expect(byUser.root).toMatchObject({ privileged: true, privilegeReason: "uid0" });
    expect(byUser.bob).toMatchObject({ privileged: true, privilegeReason: "group:docker" });
    expect(byUser.alice!.privileged).toBe(false);
  });

  it("lists cron.d files cron ignores as read-only", async () => {
    const snap = await readCronTargets(1);
    const ignored = snap.targets.find((t) => t.target.kind === "crond" && t.target.file === "php.dpkg-old");
    expect(ignored).toMatchObject({ readOnly: true });
    expect(ignored!.warning).toMatch(/ignores/);
    const ok = snap.targets.find((t) => t.target.kind === "crond" && t.target.file === "rackmap-report");
    expect(ok!.readOnly).toBeUndefined();
  });

  it("parses systemd timers", async () => {
    const snap = await readCronTargets(1);
    expect(snap.timers).toEqual([
      { unit: "logrotate.timer", activates: "logrotate.service", next: "Fri 2026-09-25 18:00:00 UTC", last: "Fri 2026-09-25 17:00:00 UTC" },
      { unit: "snapd.snap-repair.timer", activates: "snapd.snap-repair.service", next: null, last: null },
      { unit: "anacron.timer", activates: "anacron.service", next: "Fri 2026-09-25 22:33:06 UTC", last: "Fri 2026-09-25 21:42:59 UTC" },
      { unit: "e2scrub_all.timer", activates: "e2scrub_all.service", next: null, last: "Thu 2026-09-24 03:10:00 UTC" },
    ]);
    expect(parseTimers("")).toEqual([]);
  });

  it("offers /etc/crontab even when the host has none", async () => {
    host.system = null;
    const snap = await readCronTargets(1);
    expect(snap.targets.find((t) => t.target.kind === "system")).toMatchObject({ content: "", exists: false, hash: sha("") });
  });

  it("reads a user without a crontab as empty and reports missing users", async () => {
    host.users.carol = { crontab: null, priv: "" };
    const carol = await readCronTarget(1, { kind: "user", user: "carol" });
    expect(carol).toMatchObject({ content: "", hash: sha(""), exists: false, privileged: false, timezone: "Europe/Berlin" });
    const ghost = await readCronTarget(1, { kind: "user", user: "ghost" });
    expect(ghost).toMatchObject({ exists: false, readOnly: true, privileged: true });
  });
});

describe("parseCronReadOutput", () => {
  it("falls back to UTC for an unknown timezone", () => {
    const parsed = parseCronReadOutput(`${block("TZ", "Not/AZone")}===END===\n`);
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.warnings[0]).toMatch(/timezone/);
  });

  it("refuses truncated output and reports host-side fatals", () => {
    expect(() => parseCronReadOutput(block("TZ", "UTC"))).toThrow(/Incomplete/);
    expect(() => parseCronReadOutput("===FATAL:NO_BASE64===\n")).toThrow(/base64/);
  });

  it("cannot be confused by marker-like text inside a file", () => {
    const evil = "===END===\n===USER:root===\n0 * * * * /bin/evil\n";
    const parsed = parseCronReadOutput(`${block("USER:alice", evil)}${block("PRIV:alice", "")}===END===\n`);
    expect(parsed.targets).toHaveLength(1);
    expect(parsed.targets[0]).toMatchObject({ target: { kind: "user", user: "alice" }, content: evil, privileged: false });
  });

  it("skips spool names that are not valid usernames", () => {
    const parsed = parseCronReadOutput(`${block("USER:bad;name", "x")}===END===\n`);
    expect(parsed.targets).toHaveLength(0);
    expect(parsed.warnings).toHaveLength(1);
  });

  it("treats a missing privilege verdict as privileged", () => {
    const parsed = parseCronReadOutput(`${block("USER:dave", "")}===END===\n`);
    expect(parsed.targets[0]).toMatchObject({ privileged: true, privilegeReason: "unknown" });
  });
});

describe("writeCronTarget", () => {
  const alice = { kind: "user" as const, user: "alice" };

  it("writes, returns the new hash and audits a masked diff", async () => {
    const before = host.users.alice!.crontab!;
    const content = before + "0 1 * * * /home/alice/sync --token=abc123 --api-key=zzz\n";
    const res = await writeCronTarget(1, { target: alice, content, baseHash: sha(before) }, ctx);
    expect(res.hash).toBe(sha(content));
    expect(host.users.alice!.crontab).toBe(content);

    const row = await prisma.auditLog.findFirst({ where: { action: "server.cron_update" }, orderBy: { id: "desc" } });
    expect(row).not.toBeNull();
    expect(row!.afterJson).toContain(sha(content));
    expect(row!.afterJson).toContain("token=***");
    expect(row!.afterJson).not.toContain("abc123");
    expect(row!.beforeJson).toContain(sha(before));
  });

  it("appends the final newline cron requires", async () => {
    const before = host.users.alice!.crontab!;
    const res = await writeCronTarget(1, { target: alice, content: "@daily /bin/true", baseHash: sha(before) }, ctx);
    expect(host.users.alice!.crontab).toBe("@daily /bin/true\n");
    expect(res.hash).toBe(sha("@daily /bin/true\n"));
  });

  it("409 CRON_CONFLICT when the host content changed since it was read", async () => {
    await expectAppError(
      writeCronTarget(1, { target: alice, content: "@daily /bin/true\n", baseHash: sha("something else") }, ctx),
      "CRON_CONFLICT",
      409,
    );
    // Only the re-read ran; no write script was sent.
    expect(host.scripts).toHaveLength(1);
    expect(host.scripts[0]).not.toContain("base64 -d");
  });

  it("409 CRON_CONFLICT when the host-side check trips (race between read and write)", async () => {
    const before = host.users.alice!.crontab!;
    mocks.execAsRoot.mockImplementation((c: unknown, script: string) => {
      if (script.includes("base64 -d")) host.users.alice!.crontab = "# changed meanwhile\n";
      return fakeExec(c, script);
    });
    await expectAppError(writeCronTarget(1, { target: alice, content: "@daily /bin/true\n", baseHash: sha(before) }, ctx), "CRON_CONFLICT", 409);
  });

  it("400 with line numbers for invalid content, before connecting", async () => {
    const err = await expectAppError(
      writeCronTarget(1, { target: alice, content: "# ok\n0 0 L * * /bin/true\nnot a line\n", baseHash: sha("") }, ctx),
      "VALIDATION_ERROR",
      400,
    );
    expect(err.details.problems.map((p: { lineNo: number }) => p.lineNo)).toEqual([2, 3]);
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it("400 for an over-long entry", async () => {
    await expectAppError(
      writeCronTarget(1, { target: alice, content: `@daily ${"x".repeat(1000)}\n`, baseHash: sha("") }, ctx),
      "VALIDATION_ERROR",
      400,
    );
  });

  it("rejects cron.d names with a dot", async () => {
    await expectAppError(
      writeCronTarget(1, { target: { kind: "crond", file: "php.dpkg-old" }, content: "", baseHash: sha("") }, ctx, { canSudo: true }),
      "VALIDATION_ERROR",
      400,
    );
    expect(() => buildCronWriteScript({ kind: "crond", file: "a.b" }, "", sha(""))).toThrow(AppError);
  });

  it("403 for system/cron.d/root targets without server:sudo, before connecting", async () => {
    for (const target of [{ kind: "system" as const }, { kind: "crond" as const, file: "rackmap-x" }, { kind: "user" as const, user: "root" }]) {
      await expectAppError(writeCronTarget(1, { target, content: "", baseHash: sha("") }, ctx), "FORBIDDEN", 403);
    }
    expect(mocks.connectToServer).not.toHaveBeenCalled();
  });

  it("403 for a user the host reports as privileged, re-checked on the fresh read", async () => {
    const before = host.users.bob!.crontab!;
    await expectAppError(writeCronTarget(1, { target: { kind: "user", user: "bob" }, content: "", baseHash: sha(before) }, ctx), "FORBIDDEN", 403);
    const ok = await writeCronTarget(1, { target: { kind: "user", user: "bob" }, content: "", baseHash: sha(before) }, ctx, { canSudo: true });
    expect(ok.hash).toBe(sha(""));
  });

  it("403 for a shadow-group user without server:sudo (the job could read /etc/shadow)", async () => {
    host.users.sam = { crontab: "@daily /home/sam/report\n", priv: "group:shadow" };
    const before = host.users.sam.crontab!;
    const err = await expectAppError(
      writeCronTarget(1, { target: { kind: "user", user: "sam" }, content: "@hourly cat /etc/shadow\n", baseHash: sha(before) }, ctx),
      "FORBIDDEN",
      403,
    );
    expect(err.message).toMatch(/group:shadow.*server:sudo/);
    expect(host.users.sam.crontab).toBe(before);
    expect(host.scripts.some((s) => s.includes("base64 -d"))).toBe(false);
  });

  it("400 when the user does not exist on the host", async () => {
    await expectAppError(writeCronTarget(1, { target: { kind: "user", user: "ghost" }, content: "", baseHash: sha("") }, ctx), "VALIDATION_ERROR", 400);
  });

  it("writes /etc/crontab and cron.d via install, and deletes only rackmap-* files", async () => {
    const sys = "SHELL=/bin/sh\n0 4 * * * root /opt/nightly\n";
    await writeCronTarget(1, { target: { kind: "system" }, content: sys, baseHash: sha(host.system!) }, ctx, { canSudo: true });
    expect(host.system).toBe(sys);

    await expectAppError(
      writeCronTarget(1, { target: { kind: "crond", file: "backup" }, content: "", baseHash: sha(""), deleteFile: true }, ctx, { canSudo: true }),
      "VALIDATION_ERROR",
      400,
    );
    const cur = host.crond["rackmap-report"]!;
    const res = await writeCronTarget(
      1,
      { target: { kind: "crond", file: "rackmap-report" }, content: "", baseHash: sha(cur), deleteFile: true },
      ctx,
      { canSudo: true },
    );
    expect(res.hash).toBe(sha(""));
    expect(host.crond["rackmap-report"]).toBeUndefined();
  });

  it("refuses to write a read-only target", async () => {
    host.crond["huge"] = "#".repeat(70_000) + "\n";
    await expectAppError(
      writeCronTarget(1, { target: { kind: "crond", file: "huge" }, content: "", baseHash: sha(host.crond["huge"]) }, ctx, { canSudo: true }),
      "CONFLICT",
      409,
    );
  });
});

describe("generated scripts", () => {
  const MARKER = "UNIQUE_MARKER_7f3a";
  const content = `# ${MARKER}\n0 1 * * * echo '${MARKER}' \"$HOME\" \`id\` ; rm -rf /tmp/x\n`;
  const scripts = [
    buildCronWriteScript({ kind: "user", user: "alice" }, content, sha("")),
    buildCronWriteScript({ kind: "system" }, content, sha("")),
    buildCronWriteScript({ kind: "crond", file: "rackmap-x" }, content, sha("")),
  ];

  it("carry the content only as base64", () => {
    for (const s of scripts) {
      expect(s).not.toContain(MARKER);
      expect(s).toContain(b64(content));
      expect(s).toContain("base64 -d");
    }
  });

  it("never feed a crontab through stdin (`crontab -`)", () => {
    for (const s of [...scripts, buildCronReadAllScript()]) {
      expect(s).not.toMatch(/crontab(?:\s+-u\s+\S+)?\s+-(?:\s|$|;|\|)/m);
      expect(s).not.toMatch(/\|\s*crontab\b/);
    }
    expect(scripts[0]).toContain('crontab -u "$U" "$W/new"');
    expect(scripts[1]).toContain("install -o root -g root -m 0644");
    expect(scripts[2]).toContain("F='/etc/cron.d/rackmap-x'");
  });

  it("back up to /var/backups/rackmap-cron and keep 10", () => {
    expect(scripts[0]).toContain("B=/var/backups/rackmap-cron");
    expect(scripts[0]).toContain("P='user-alice'");
    expect(scripts[0]).toContain("tail -n +11");
  });

  it("escape the run command and feed the % part on stdin", () => {
    const s = buildCronRunScript("alice", "printf 'it'\\''s' | cat%line one%two", { SHELL: "/bin/bash", MAILTO: "ops@example.com", "BAD-NAME": "x" });
    expect(s).toContain("U='alice'");
    expect(s).toContain("runuser -u \"$U\" --");
    expect(s).toContain(`'/bin/bash' -c ${escapeShellArg("printf 'it'\\''s' | cat")}`);
    expect(s).toContain(b64("line one\ntwo\n"));
    expect(s).toContain("'MAILTO=ops@example.com'");
    expect(s).not.toContain("BAD-NAME");
    expect(() => buildCronRunScript("bad;user", "true", {})).toThrow(AppError);
  });
});

describe("runCronEntry", () => {
  it("runs the entry as its user and audits the masked command", async () => {
    const before = host.users.root!.crontab!;
    const res = await runCronEntry(1, { target: { kind: "user", user: "root" }, lineNo: 1, baseHash: sha(before) }, ctx, { canSudo: true });
    expect(res).toMatchObject({ exitCode: 3, stdout: "hello from the job\n", truncated: false, timedOut: false });
    const runScript = host.scripts.find((s) => s.includes("runuser"))!;
    expect(runScript).toContain("U='root'");
    const opts = mocks.execAsRoot.mock.calls.at(-1)![3];
    expect(opts).toMatchObject({ timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });

    const row = await prisma.auditLog.findFirst({ where: { action: "server.cron_run" }, orderBy: { id: "desc" } });
    expect(row!.afterJson).toContain("password=***");
    expect(row!.afterJson).not.toContain("hunter2");
  });

  it("uses the user column of system entries and refuses non-entries", async () => {
    await runCronEntry(1, { target: { kind: "system" }, lineNo: 2, baseHash: sha(host.system!) }, ctx, { canSudo: true });
    expect(host.scripts.at(-1)).toContain("U='root'");
    await expectAppError(
      runCronEntry(1, { target: { kind: "system" }, lineNo: 1, baseHash: sha(host.system!) }, ctx, { canSudo: true }),
      "VALIDATION_ERROR",
      400,
    );
  });

  it("403 for a job owned by a shadow-group user without server:sudo, before running it", async () => {
    host.users.sam = { crontab: "@daily cat /etc/shadow\n", priv: "group:shadow" };
    await expectAppError(
      runCronEntry(1, { target: { kind: "user", user: "sam" }, lineNo: 1, baseHash: sha(host.users.sam.crontab!) }, ctx),
      "FORBIDDEN",
      403,
    );
    expect(host.scripts.some((s) => s.includes("runuser"))).toBe(false);
  });

  it("409 when the target changed", async () => {
    await expectAppError(
      runCronEntry(1, { target: { kind: "user", user: "alice" }, lineNo: 2, baseHash: sha("stale") }, ctx),
      "CRON_CONFLICT",
      409,
    );
  });
});

describe("priv_block (the read script under a real /bin/sh)", () => {
  /** Run the single-user read script with `id`, `crontab`, `sudo` and `timedatectl` stubbed as shell functions. */
  function readWithGroups(user: string, groups: string) {
    const stubs = [
      `id() { case "$1" in -u) echo 1001 ;; -Gn) echo ${escapeShellArg(groups)} ;; esac; }`,
      "crontab() { printf '@daily /bin/true\\n'; }",
      "sudo() { return 1; }",
      "timedatectl() { return 1; }",
    ].join("\n");
    // -c, not stdin: the script's prelude redirects stdin to /dev/null.
    const stdout = execFileSync("/bin/sh", ["-c", `${stubs}\n${buildCronReadTargetScript({ kind: "user", user })}`], { encoding: "utf8" });
    return parseCronReadOutput(stdout).targets.find((t) => t.target.kind === "user" && t.target.user === user);
  }

  it.each([...PRIVILEGED_OS_GROUPS])("a member of %s is root-equivalent", (g) => {
    expect(readWithGroups("sam", `sam users ${g}`)).toMatchObject({ privileged: true, privilegeReason: `group:${g}` });
  });

  it("an ordinary user is not", () => {
    const snap = readWithGroups("sam", "sam users www-data");
    expect(snap).toMatchObject({ privileged: false, content: "@daily /bin/true\n" });
    expect(snap!.privilegeReason).toBeUndefined();
  });
});

describe("cronErrorToHttp", () => {
  it("keeps VAULT_LOCKED from a locked vault so the client can prompt to unlock", () => {
    expect(cronErrorToHttp(new SshError("vault_locked", "locked"))).toMatchObject({ status: 409, code: "VAULT_LOCKED" });
  });

  it("falls back to SSH_ERROR for SSH failures without a client code", () => {
    expect(cronErrorToHttp(new SshError("unreachable", "down"))).toEqual({
      status: 503,
      code: "SSH_ERROR",
      message: "Server is unreachable over SSH",
    });
  });
});
