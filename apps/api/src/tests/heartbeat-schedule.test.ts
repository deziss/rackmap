import { describe, it, expect } from "vitest";
import { normalizeHeartbeatSchedule } from "@inv/shared";
import {
  computeAfterEdit,
  computeAfterPing,
  computeAfterStart,
  computeInitial,
  nextExpectedCronRun,
  tzOffsetMs,
  type HeartbeatScheduleFields,
} from "../services/heartbeat-schedule.js";

/**
 * The deadline math decides when an operator gets paged, so the cases that bite
 * once a year (DST) and the ones that bite every day (host clock skew) are pinned
 * here with fixed instants.
 */

const at = (s: string) => new Date(s);
const iso = (d: Date | null) => d?.toISOString() ?? null;

function cron(schedule: string, timezone = "UTC", graceSeconds = 300): HeartbeatScheduleFields {
  return { kind: "cron", schedule, timezone, periodSeconds: null, graceSeconds, maxRuntimeSeconds: null };
}

describe("cron deadlines", () => {
  it("expects the next run and adds the grace period", () => {
    const d = computeAfterPing(cron("0 2 * * *"), at("2026-01-10T02:03:00Z"));
    expect(iso(d.expectedAt)).toBe("2026-01-11T02:00:00.000Z");
    expect(iso(d.alertAt)).toBe("2026-01-11T02:05:00.000Z");
  });

  it("absorbs host clock skew: a ping just before the run belongs to that run", () => {
    // Host clock 5s fast: the 02:00 job pings at 01:59:55 our time.
    const d = computeAfterPing(cron("0 2 * * *"), at("2026-01-10T01:59:55Z"));
    expect(iso(d.expectedAt)).toBe("2026-01-11T02:00:00.000Z");
  });

  it("caps the skew window at half the period for frequent jobs", () => {
    // Every minute: a ping 50s into the minute must still expect the next minute.
    const d = computeAfterPing(cron("* * * * *"), at("2026-01-10T10:00:10Z"));
    expect(iso(d.expectedAt)).toBe("2026-01-10T10:01:00.000Z");
    const every5 = computeAfterPing(cron("*/5 * * * *"), at("2026-01-10T10:03:00Z"));
    expect(iso(every5.expectedAt)).toBe("2026-01-10T10:05:00.000Z");
  });

  it("honours day-of-month OR day-of-week like vixie cron", () => {
    // 1st of the month OR Monday.
    const d = computeAfterPing(cron("0 0 1 * 1"), at("2026-01-01T12:00:00Z"));
    expect(iso(d.expectedAt)).toBe("2026-01-05T00:00:00.000Z");
  });
});

describe("DST", () => {
  it("America/New_York spring forward (2026-03-08): a 02:30 job", () => {
    const hb = cron("30 2 * * *", "America/New_York");
    // Saturday's run at 02:30 EST.
    const sat = computeAfterPing(hb, at("2026-03-07T07:31:00Z"));
    // 02:30 does not exist on Sunday; the schedule places it at 03:30 EDT…
    expect(iso(sat.expectedAt)).toBe("2026-03-08T07:30:00.000Z");
    // …but cron runs the skipped job at the jump (03:00 EDT = 07:00Z). That early
    // ping must count as Sunday's run, not leave 03:30 expected (a false alarm).
    const sun = computeAfterPing(hb, at("2026-03-08T07:00:20Z"));
    expect(iso(sun.expectedAt)).toBe("2026-03-09T06:30:00.000Z");
    // Monday is back to normal: 02:30 EDT.
    const mon = computeAfterPing(hb, at("2026-03-09T06:31:00Z"));
    expect(iso(mon.expectedAt)).toBe("2026-03-10T06:30:00.000Z");
  });

  it("America/New_York fall back (2026-11-01): a 01:30 job runs once, not twice", () => {
    const hb = cron("30 1 * * *", "America/New_York");
    // First 01:30 (EDT, 05:30Z); the repeated 01:30 EST must not be expected.
    const d = computeAfterPing(hb, at("2026-11-01T05:31:00Z"));
    expect(iso(d.expectedAt)).toBe("2026-11-02T06:30:00.000Z");
  });

  it("Europe/London spring forward (2026-03-29): a 01:30 job", () => {
    const hb = cron("30 1 * * *", "Europe/London");
    const sat = computeAfterPing(hb, at("2026-03-28T01:31:00Z"));
    expect(iso(sat.expectedAt)).toBe("2026-03-29T01:30:00.000Z");
    // cron fires it at 02:00 BST (01:00Z).
    const sun = computeAfterPing(hb, at("2026-03-29T01:00:30Z"));
    expect(iso(sun.expectedAt)).toBe("2026-03-30T00:30:00.000Z");
  });

  it("Europe/London fall back (2026-10-25)", () => {
    const hb = cron("30 1 * * *", "Europe/London");
    const d = computeAfterPing(hb, at("2026-10-25T00:31:00Z"));
    expect(iso(d.expectedAt)).toBe("2026-10-26T01:30:00.000Z");
  });

  it("does not widen the window on an ordinary day", () => {
    // Hourly job, no transition anywhere near: a ping 40 min before the next run is the previous run.
    expect(iso(nextExpectedCronRun("0 * * * *", "America/New_York", at("2026-06-01T10:20:00Z")))).toBe("2026-06-01T11:00:00.000Z");
  });

  it("reads zone offsets", () => {
    expect(tzOffsetMs(at("2026-07-01T12:00:00Z"), "America/New_York")).toBe(-4 * 3600_000);
    expect(tzOffsetMs(at("2026-01-01T12:00:00Z"), "America/New_York")).toBe(-5 * 3600_000);
    expect(tzOffsetMs(at("2026-07-01T12:00:00Z"), "Europe/London")).toBe(3600_000);
  });
});

describe("period deadlines", () => {
  it("expects the next ping one period after the last", () => {
    const hb: HeartbeatScheduleFields = { kind: "period", schedule: null, timezone: "UTC", periodSeconds: 3600, graceSeconds: 600, maxRuntimeSeconds: null };
    const d = computeAfterPing(hb, at("2026-01-10T10:07:00Z"));
    expect(iso(d.expectedAt)).toBe("2026-01-10T11:07:00.000Z");
    expect(iso(d.alertAt)).toBe("2026-01-10T11:17:00.000Z");
  });
});

describe("/start", () => {
  const hb = { ...cron("0 2 * * *"), maxRuntimeSeconds: 3600 };
  const current = { expectedAt: at("2026-01-11T02:00:00Z"), alertAt: at("2026-01-11T02:05:00Z") };

  it("gives the scheduled run its max runtime to finish", () => {
    const d = computeAfterStart(hb, at("2026-01-11T02:00:02Z"), current);
    expect(iso(d.alertAt)).toBe("2026-01-11T03:00:02.000Z");
    expect(iso(d.expectedAt)).toBe("2026-01-11T02:00:00.000Z");
  });

  it("an unscheduled early start can only tighten the deadline", () => {
    const early = computeAfterStart({ ...hb, maxRuntimeSeconds: 60 }, at("2026-01-10T12:00:00Z"), current);
    expect(iso(early.alertAt)).toBe("2026-01-10T12:01:00.000Z");
    const long = computeAfterStart(hb, at("2026-01-11T01:30:00Z"), current);
    expect(iso(long.alertAt)).toBe("2026-01-11T02:05:00.000Z");
  });

  it("falls back to the grace period without a max runtime", () => {
    const d = computeAfterStart(cron("0 2 * * *"), at("2026-01-11T02:00:00Z"), { expectedAt: null, alertAt: null });
    expect(iso(d.alertAt)).toBe("2026-01-11T02:05:00.000Z");
  });
});

describe("initial and edited deadlines", () => {
  it("a heartbeat created from the cron editor expects the first run immediately", () => {
    const d = computeInitial(cron("*/10 * * * *"), at("2026-01-10T10:01:00Z"), true);
    expect(iso(d.expectedAt)).toBe("2026-01-10T10:10:00.000Z");
    expect(iso(d.alertAt)).toBe("2026-01-10T10:15:00.000Z");
  });

  it("a hand-made heartbeat expects nothing until its first ping", () => {
    expect(computeInitial(cron("*/10 * * * *"), at("2026-01-10T10:01:00Z"), false)).toEqual({ expectedAt: null, alertAt: null });
  });

  it("an edit never makes a heartbeat overdue on its own", () => {
    // Last ran yesterday on a daily schedule; switching to hourly would be overdue
    // from the last ping, so the clock restarts from now.
    const d = computeAfterEdit(cron("0 * * * *"), at("2026-01-09T02:00:00Z"), at("2026-01-10T10:20:00Z"), true);
    expect(iso(d.expectedAt)).toBe("2026-01-10T11:00:00.000Z");
    // A grace change that keeps the deadline in the future is computed from the last ping.
    const g = computeAfterEdit(cron("0 2 * * *", "UTC", 900), at("2026-01-10T02:01:00Z"), at("2026-01-10T10:00:00Z"), true);
    expect(iso(g.alertAt)).toBe("2026-01-11T02:15:00.000Z");
  });
});

describe("schedule normalisation", () => {
  it("expands nicknames and refuses @reboot and croner-only syntax", () => {
    expect(normalizeHeartbeatSchedule("@daily")).toEqual({ ok: true, expr: "0 0 * * *" });
    expect(normalizeHeartbeatSchedule("@reboot").ok).toBe(false);
    expect(normalizeHeartbeatSchedule("0 0 L * *").ok).toBe(false);
    expect(normalizeHeartbeatSchedule("0 0 * * 5#2").ok).toBe(false);
    expect(normalizeHeartbeatSchedule("0 0 * * * 2026").ok).toBe(false);
    expect(normalizeHeartbeatSchedule("*/15 9-17 * * mon-fri")).toEqual({ ok: true, expr: "*/15 9-17 * * mon-fri" });
  });
});
