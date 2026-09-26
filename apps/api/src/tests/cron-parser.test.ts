import { describe, it, expect } from "vitest";
import {
  CronTarget,
  diffCronLines,
  formatCronEntry,
  formatCronLabelLine,
  insertCronEntry,
  nextCronRuns,
  parseCrontab,
  removeCronEntry,
  serializeCrontab,
  splitCronCommand,
  updateCronEntry,
  validateCronSchedule,
  validateCrontab,
  cronEnvAt,
  type CronEntryLine,
  type CronLine,
} from "@inv/shared";

const USER_FIXTURE = [
  "# m h dom mon dow command",
  "MAILTO=ops@example.com",
  'SHELL = "/bin/bash"',
  "CRON_TZ=America/New_York",
  "",
  "# rackmap: Nightly backup",
  "30 2 * * * /usr/local/bin/backup.sh --target s3://backups.example.com",
  "# rackmap: DB dump hb=42",
  "0 */6 * * * pg_dump app > /var/backups/app-$(date +\\%F).sql",
  "@reboot /usr/local/bin/warm-cache",
  "#rackmap:disabled */15 * * * * curl -fsS https://example.com/ping",
  'MAILTO=""',
  "15 9-17 * * mon-fri mail -s status ops@example.com%line one%line two",
  "\t5  4   *  *  sun   /usr/bin/weekly   --flag   ",
  "bogus line here",
  "",
].join("\n");

const SYSTEM_FIXTURE = [
  "SHELL=/bin/sh",
  "PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin",
  "# Example of job definition:",
  "17 *\t* * *\troot    cd / && run-parts --report /etc/cron.hourly",
  "25 6\t* * *\troot\ttest -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.daily )",
  "@reboot www-data /usr/local/bin/start-worker",
  "#rackmap:disabled 0 3 * * * backup /opt/backup/run.sh",
  "",
].join("\n");

function entries(lines: CronLine[]): CronEntryLine[] {
  return lines.filter((l): l is CronEntryLine => l.type === "entry");
}

function changedLineIndexes(a: string, b: string): number[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out: number[] = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) out.push(i);
  return out;
}

describe("parseCrontab / serializeCrontab — user format", () => {
  const lines = parseCrontab(USER_FIXTURE, "user");

  it("round-trips byte-for-byte", () => {
    expect(serializeCrontab(lines)).toBe(USER_FIXTURE);
  });

  it("classifies every line", () => {
    expect(lines.map((l) => l.type)).toEqual([
      "comment",
      "env",
      "env",
      "env",
      "blank",
      "comment",
      "entry",
      "comment",
      "entry",
      "entry",
      "entry",
      "env",
      "entry",
      "entry",
      "invalid",
    ]);
    expect(lines.map((l) => l.lineNo)).toEqual(lines.map((_, i) => i + 1));
  });

  it("parses env lines, including quoted names/values and CRON_TZ", () => {
    const env = lines.filter((l) => l.type === "env");
    expect(env.map((l) => (l.type === "env" ? [l.name, l.value] : null))).toEqual([
      ["MAILTO", "ops@example.com"],
      ["SHELL", "/bin/bash"],
      ["CRON_TZ", "America/New_York"],
      ["MAILTO", ""],
    ]);
    expect(cronEnvAt(lines, 7)).toMatchObject({ CRON_TZ: "America/New_York", SHELL: "/bin/bash" });
  });

  it("extracts schedule, command, labels, heartbeat ids and disabled entries", () => {
    const [backup, dump, reboot, disabled, mail, weekly] = entries(lines);
    expect(backup).toMatchObject({ schedule: "30 2 * * *", label: "Nightly backup", disabled: false });
    expect(backup!.heartbeatId).toBeUndefined();
    expect(dump).toMatchObject({ schedule: "0 */6 * * *", label: "DB dump", heartbeatId: 42 });
    expect(dump!.command).toBe("pg_dump app > /var/backups/app-$(date +\\%F).sql");
    expect(reboot).toMatchObject({ schedule: "@reboot", command: "/usr/local/bin/warm-cache" });
    expect(disabled).toMatchObject({ schedule: "*/15 * * * *", disabled: true, command: "curl -fsS https://example.com/ping" });
    // `%` stays in the command verbatim.
    expect(mail!.command).toBe("mail -s status ops@example.com%line one%line two");
    // Whitespace between fields is normalised in `schedule`, the command keeps its trailing spaces.
    expect(weekly).toMatchObject({ schedule: "5 4 * * sun", command: "/usr/bin/weekly   --flag   " });
    for (const e of entries(lines)) expect(e.user).toBeUndefined();
  });

  it("reports the invalid line with a reason", () => {
    const bad = lines.find((l) => l.type === "invalid");
    expect(bad).toMatchObject({ lineNo: 15, raw: "bogus line here" });
    expect(validateCrontab(USER_FIXTURE, "user")).toEqual([{ lineNo: 15, error: expect.any(String) }]);
  });

  it("editing one entry changes only that line", () => {
    const [backup] = entries(lines);
    const out = serializeCrontab(updateCronEntry(lines, backup!.lineNo, { schedule: "45 3 * * *" }));
    expect(changedLineIndexes(USER_FIXTURE, out)).toEqual([backup!.lineNo - 1]);
    expect(out.split("\n")[backup!.lineNo - 1]).toBe("45 3 * * * /usr/local/bin/backup.sh --target s3://backups.example.com");
  });

  it("disabling / enabling toggles only the prefix", () => {
    const e = entries(lines)[2]!; // @reboot
    const off = serializeCrontab(updateCronEntry(lines, e.lineNo, { disabled: true }));
    expect(changedLineIndexes(USER_FIXTURE, off)).toEqual([e.lineNo - 1]);
    expect(off.split("\n")[e.lineNo - 1]).toBe("#rackmap:disabled @reboot /usr/local/bin/warm-cache");
    const on = parseCrontab(off, "user");
    const back = serializeCrontab(updateCronEntry(on, e.lineNo, { disabled: false }));
    expect(back).toBe(USER_FIXTURE);
  });

  it("rewrites, inserts and drops label lines", () => {
    const [backup, dump, reboot] = entries(lines);
    const relabeled = serializeCrontab(updateCronEntry(lines, backup!.lineNo, { label: "Backup v2" }));
    expect(changedLineIndexes(USER_FIXTURE, relabeled)).toEqual([backup!.lineNo - 2]);
    expect(relabeled.split("\n")[backup!.lineNo - 2]).toBe("# rackmap: Backup v2");

    const withHb = serializeCrontab(updateCronEntry(lines, backup!.lineNo, { heartbeatId: 7 }));
    expect(withHb.split("\n")[backup!.lineNo - 2]).toBe("# rackmap: Nightly backup hb=7");

    const unmonitored = serializeCrontab(updateCronEntry(lines, dump!.lineNo, { heartbeatId: undefined }));
    expect(unmonitored.split("\n")[dump!.lineNo - 2]).toBe("# rackmap: DB dump");

    const inserted = parseCrontab(serializeCrontab(updateCronEntry(lines, reboot!.lineNo, { label: "Warm cache" })), "user");
    const e = entries(inserted)[2]!;
    expect(e.label).toBe("Warm cache");
    expect(inserted[e.lineNo - 2]!.raw).toBe("# rackmap: Warm cache");

    const removed = serializeCrontab(removeCronEntry(lines, backup!.lineNo));
    expect(removed).not.toContain("Nightly backup");
    expect(removed).not.toContain("backup.sh");
    expect(removed.split("\n").length).toBe(USER_FIXTURE.split("\n").length - 2);
  });

  it("inserts a new entry without touching existing lines", () => {
    const out = serializeCrontab(insertCronEntry(lines, { schedule: "*/5 * * * *", command: "/opt/job", label: "Every five" }));
    expect(out.startsWith(USER_FIXTURE)).toBe(true);
    expect(out.slice(USER_FIXTURE.length)).toBe("# rackmap: Every five\n*/5 * * * * /opt/job\n");
  });

  it("terminates a final line that lacked a newline (the only normalisation)", () => {
    const text = "0 1 * * * /bin/true";
    expect(serializeCrontab(parseCrontab(text, "user"))).toBe(text + "\n");
    expect(serializeCrontab(parseCrontab("", "user"))).toBe("");
  });

  it("flags CRLF entries instead of silently passing \\r to the command", () => {
    const lines2 = parseCrontab("0 1 * * * /bin/true\r\n", "user");
    expect(lines2[0]).toMatchObject({ type: "invalid" });
  });
});

describe("parseCrontab / serializeCrontab — system format", () => {
  const lines = parseCrontab(SYSTEM_FIXTURE, "system");

  it("round-trips byte-for-byte", () => {
    expect(serializeCrontab(lines)).toBe(SYSTEM_FIXTURE);
  });

  it("reads the user column", () => {
    const e = entries(lines);
    expect(e.map((x) => [x.schedule, x.user, x.disabled])).toEqual([
      ["17 * * * *", "root", false],
      ["25 6 * * *", "root", false],
      ["@reboot", "www-data", false],
      ["0 3 * * *", "backup", true],
    ]);
    expect(e[0]!.command).toBe("cd / && run-parts --report /etc/cron.hourly");
  });

  it("requires the user column", () => {
    const bad = parseCrontab("0 1 * * * \n", "system");
    expect(bad[0]).toMatchObject({ type: "invalid" });
    // A user-format line in a system crontab: "/bin/true" is not a username.
    expect(parseCrontab("0 1 * * * /bin/true\n", "system")[0]).toMatchObject({ type: "invalid" });
    expect(parseCrontab("0 1 * * * root\n", "system")[0]).toMatchObject({ type: "invalid", error: "Missing command" });
    expect(parseCrontab("0 1 * * * bad;user cmd\n", "system")[0]).toMatchObject({ type: "invalid" });
  });

  it("formats system entries with the user", () => {
    expect(formatCronEntry({ schedule: "0 4 * * *", user: "backup", command: "/opt/run" }, "system")).toBe("0 4 * * * backup /opt/run");
    expect(formatCronEntry({ schedule: "@daily", command: "/opt/run", disabled: true }, "user")).toBe("#rackmap:disabled @daily /opt/run");
  });

  it("editing one entry changes only that line", () => {
    const e = entries(lines)[1]!;
    const out = serializeCrontab(updateCronEntry(lines, e.lineNo, { user: "nobody" }));
    expect(changedLineIndexes(SYSTEM_FIXTURE, out)).toEqual([e.lineNo - 1]);
  });
});

describe("validateCronSchedule (vixie/cronie subset)", () => {
  it.each([
    "*/5 * * * *",
    "0 0 1 jan-mar/2 *",
    "15 9-17 * * mon-fri",
    "0 0 * * 7",
    "0 0 * * SUN",
    "1,2,3-5 * * * *",
    "0-59/15 * * * *",
    "0 0 1,15 * 1",
    "@reboot",
    "@yearly",
    "@annually",
    "@monthly",
    "@weekly",
    "@daily",
    "@midnight",
    "@hourly",
  ])("accepts %s", (expr) => {
    expect(validateCronSchedule(expr)).toEqual({ ok: true });
  });

  it.each([
    ["0 0 L * *", "L"],
    ["0 0 15W * *", "W"],
    ["0 0 * * 5#2", "#"],
    ["0 0 ? * *", "?"],
    ["0 0 * * * 2026", "year field"],
    ["0 */5 * * * *", "seconds field"],
    ["5/10 * * * *", "numeric step prefix"],
    ["@every 5m", "unknown nickname"],
    ["60 * * * *", "minute range"],
    ["0 24 * * *", "hour range"],
    ["0 0 0 * *", "day range"],
    ["0 0 * 13 *", "month range"],
    ["0 0 * * 8", "weekday range"],
    ["5-1 * * * *", "reversed range"],
    ["*/0 * * * *", "zero step"],
    ["0 0 * * mon/2", "step on a single name"],
    ["0 0 * foo *", "bad name"],
    ["* * * *", "too few fields"],
  ])("rejects %s (%s)", (expr) => {
    const r = validateCronSchedule(expr);
    expect(r.ok).toBe(false);
  });
});

describe("nextCronRuns", () => {
  const from = new Date("2026-03-07T12:00:00Z");

  it("follows the host timezone across the 2026-03-08 US DST change", () => {
    const noon = nextCronRuns("0 12 * * *", { timezone: "America/New_York", count: 3, from }).map((d) => d.toISOString());
    // 12:00 EST = 17:00Z, then 12:00 EDT = 16:00Z.
    expect(noon).toEqual(["2026-03-07T17:00:00.000Z", "2026-03-08T16:00:00.000Z", "2026-03-09T16:00:00.000Z"]);

    // 02:30 does not exist on 2026-03-08 in New York; the day is not skipped.
    const skipped = nextCronRuns("30 2 * * *", { timezone: "America/New_York", count: 2, from }).map((d) => d.toISOString());
    expect(skipped[0]!.startsWith("2026-03-08T")).toBe(true);
    expect(skipped[1]).toBe("2026-03-09T06:30:00.000Z");
  });

  it("uses OR semantics for day-of-month + day-of-week like vixie cron", () => {
    const runs = nextCronRuns("0 0 1,15 * 1", { timezone: "UTC", count: 3, from }).map((d) => d.toISOString().slice(0, 10));
    expect(runs).toEqual(["2026-03-09", "2026-03-15", "2026-03-16"]);
  });

  it("expands nicknames, returns [] for @reboot and invalid schedules", () => {
    expect(nextCronRuns("@hourly", { timezone: "UTC", count: 2, from }).map((d) => d.toISOString())).toEqual([
      "2026-03-07T13:00:00.000Z",
      "2026-03-07T14:00:00.000Z",
    ]);
    expect(nextCronRuns("@reboot", { from })).toEqual([]);
    expect(nextCronRuns("0 0 L * *", { from })).toEqual([]);
  });
});

describe("helpers", () => {
  it("splits the % stdin part like cron", () => {
    expect(splitCronCommand("mail -s hi ops@example.com%line one%line two")).toEqual({
      command: "mail -s hi ops@example.com",
      stdin: "line one\nline two\n",
    });
    expect(splitCronCommand("date +\\%F > /tmp/x")).toEqual({ command: "date +%F > /tmp/x", stdin: null });
  });

  it("never lets a label forge a heartbeat link", () => {
    expect(formatCronLabelLine("backup hb=9")).toBe("# rackmap: backup");
    expect(formatCronLabelLine("backup", 3)).toBe("# rackmap: backup hb=3");
    expect(formatCronLabelLine(undefined, 3)).toBe("# rackmap: hb=3");
    expect(parseCrontab("# rackmap: hb=3\n@daily /bin/true\n", "user")[1]).toMatchObject({ heartbeatId: 3 });
  });

  it("flags enabled lines over 990 characters, not disabled ones", () => {
    const long = "x".repeat(1000);
    expect(validateCrontab(`@daily ${long}\n`, "user")).toHaveLength(1);
    expect(validateCrontab(`#rackmap:disabled @daily ${long}\n`, "user")).toHaveLength(0);
  });

  it("diffs lines", () => {
    const ops = diffCronLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(ops).toEqual([
      { op: "same", text: "a" },
      { op: "add", text: "B" },
      { op: "del", text: "b" },
      { op: "same", text: "c" },
      { op: "add", text: "d" },
    ]);
  });

  it("CronTarget rejects cron.d names cron would ignore", () => {
    expect(CronTarget.safeParse({ kind: "crond", file: "foo.bar" }).success).toBe(false);
    expect(CronTarget.safeParse({ kind: "crond", file: "rackmap-backup" }).success).toBe(true);
    expect(CronTarget.safeParse({ kind: "user", user: "bad;name" }).success).toBe(false);
  });
});
