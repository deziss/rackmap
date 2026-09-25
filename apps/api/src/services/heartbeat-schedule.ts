import { Cron } from "croner";
import { normalizeHeartbeatSchedule } from "@inv/shared";

/**
 * Deadline math for heartbeats. Pure: no database, no clock — every function takes
 * the moment it reasons about, so the sweeper and the tests can pass `now`.
 *
 * Two instants per heartbeat:
 *  - expectedAt — when the next ping is due. Passing it makes an `up` heartbeat `late`.
 *  - alertAt    — expectedAt + grace (or start + max runtime while a run is in
 *                 flight). Passing it makes the heartbeat `down` and raises an alert.
 */

export interface HeartbeatScheduleFields {
  kind: string;
  schedule: string | null;
  timezone: string;
  periodSeconds: number | null;
  graceSeconds: number;
  maxRuntimeSeconds: number | null;
}

export interface Deadlines {
  expectedAt: Date | null;
  alertAt: Date | null;
}

/** Host clocks drift; a ping this close before a scheduled run still belongs to the previous one. */
const MAX_SKEW_MS = 60_000;
/** Look this far back for a DST transition that may have made cron fire a run early. */
const DST_LOOKBACK_MS = 3 * 3600_000;

/** croner in vixie mode: 5 fields, day-of-month OR day-of-week, never scheduling anything itself. */
export function makeCron(schedule: string, timezone: string): Cron {
  const r = normalizeHeartbeatSchedule(schedule);
  if (!r.ok) throw new Error(r.error);
  return new Cron(r.expr, { timezone, mode: "5-part", domAndDow: false, paused: true });
}

/** Next run strictly after `from`, or null when the expression can never fire again. */
export function nextCronRun(schedule: string, timezone: string, from: Date): Date | null {
  return makeCron(schedule, timezone).nextRun(from);
}

/** Throws with a readable message when the schedule/timezone pair cannot produce a next run. */
export function assertSchedulable(schedule: string, timezone: string, from = new Date()): void {
  if (!nextCronRun(schedule, timezone, from)) throw new Error("The schedule never fires");
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** UTC offset of `tz` at instant `d`, in ms (e.g. -4h for New York in summer). */
export function tzOffsetMs(d: Date, tz: string): number {
  let fmt = offsetFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(tz, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - (Math.floor(d.getTime() / 1000) * 1000);
}

/**
 * How early a ping may arrive and still count as the NEXT scheduled run.
 *
 * Base: min(60s, half the gap to the run after) — absorbs host clock skew, so a
 * 02:00 job whose host clock runs 5s fast (ping at 01:59:55) points at tomorrow,
 * not at the 02:00 it just performed.
 *
 * DST: when the clocks jump forward, cron runs the jobs of the skipped hour right
 * at the jump (03:00), while croner places a 02:30 job at 03:30. Without widening
 * the window, the 03:00 ping would be taken as "early", tomorrow's run would never
 * be expected and the 03:30 deadline would raise a false alarm once a year. Still
 * capped at half the period, so a frequent job can never swallow a real run.
 */
function earlyTolerance(next1: Date, next2: Date | null, timezone: string): number {
  const half = next2 ? (next2.getTime() - next1.getTime()) / 2 : MAX_SKEW_MS;
  const shift = Math.abs(tzOffsetMs(next1, timezone) - tzOffsetMs(new Date(next1.getTime() - DST_LOOKBACK_MS), timezone));
  return Math.max(0, Math.min(MAX_SKEW_MS + shift, half));
}

/** The run a completion ping at `t` is waiting for next (cron heartbeats). */
export function nextExpectedCronRun(schedule: string, timezone: string, t: Date): Date | null {
  const cron = makeCron(schedule, timezone);
  const next1 = cron.nextRun(t);
  if (!next1) return null;
  let next2 = cron.nextRun(next1);
  // croner can hand the same instant back right after a DST jump; step past it.
  if (next2 && next2.getTime() <= next1.getTime()) next2 = cron.nextRun(new Date(next1.getTime() + 60_000));
  const tol = earlyTolerance(next1, next2, timezone);
  return cron.nextRun(new Date(t.getTime() + tol));
}

function plus(d: Date | null, seconds: number): Date | null {
  return d ? new Date(d.getTime() + seconds * 1000) : null;
}

/** Deadlines after a completion (success or fail) ping at `t`. */
export function computeAfterPing(hb: HeartbeatScheduleFields, t: Date): Deadlines {
  let expectedAt: Date | null = null;
  if (hb.kind === "period") {
    expectedAt = hb.periodSeconds ? new Date(t.getTime() + hb.periodSeconds * 1000) : null;
  } else if (hb.schedule) {
    expectedAt = nextExpectedCronRun(hb.schedule, hb.timezone, t);
  }
  return { expectedAt, alertAt: plus(expectedAt, hb.graceSeconds) };
}

/**
 * Deadline after a `/start` ping at `t`: the run has to finish within
 * maxRuntimeSeconds (default: the grace period).
 *
 * Once the scheduled run has begun (the start arrives no earlier than the usual
 * early-ping window before expectedAt), the completion deadline replaces the
 * schedule deadline — otherwise a 30-minute job with a 1-hour max runtime would be
 * declared down 5 minutes (grace) after it started. An unscheduled early start can
 * only tighten the existing deadline, never push it out.
 */
export function computeAfterStart(hb: HeartbeatScheduleFields, t: Date, current: Deadlines): Deadlines {
  const runtimeDeadline = new Date(t.getTime() + (hb.maxRuntimeSeconds ?? hb.graceSeconds) * 1000);
  if (!current.alertAt || !current.expectedAt) return { expectedAt: current.expectedAt, alertAt: runtimeDeadline };
  const scheduledRunBegun = t.getTime() >= current.expectedAt.getTime() - MAX_SKEW_MS;
  if (scheduledRunBegun) return { expectedAt: current.expectedAt, alertAt: runtimeDeadline };
  return {
    expectedAt: current.expectedAt,
    alertAt: runtimeDeadline < current.alertAt ? runtimeDeadline : current.alertAt,
  };
}

/**
 * Deadlines for a heartbeat that has not pinged yet.
 *
 * Created by the cron editor (`armed`): the job is already scheduled on the host, so
 * the first run is expected right away — a job that NEVER runs still alerts.
 * Created by hand: nothing is expected until the first ping, because the job may
 * not be wired up yet.
 */
export function computeInitial(hb: HeartbeatScheduleFields, now: Date, armed: boolean): Deadlines {
  if (!armed) return { expectedAt: null, alertAt: null };
  let expectedAt: Date | null = null;
  if (hb.kind === "period") {
    expectedAt = hb.periodSeconds ? new Date(now.getTime() + hb.periodSeconds * 1000) : null;
  } else if (hb.schedule) {
    expectedAt = nextCronRun(hb.schedule, hb.timezone, now);
  }
  return { expectedAt, alertAt: plus(expectedAt, hb.graceSeconds) };
}

/**
 * Deadlines after the schedule, period or grace was edited. Recomputed from the last
 * completion ping; if that would already be overdue, from `now` instead — an edit
 * never raises an alert by itself.
 */
export function computeAfterEdit(hb: HeartbeatScheduleFields, lastCompletionAt: Date | null, now: Date, armed: boolean): Deadlines {
  if (!lastCompletionAt) return computeInitial(hb, now, armed);
  const fromLast = computeAfterPing(hb, lastCompletionAt);
  if (fromLast.alertAt && fromLast.alertAt.getTime() > now.getTime() && fromLast.expectedAt && fromLast.expectedAt.getTime() > now.getTime()) {
    return fromLast;
  }
  return computeAfterPing(hb, now);
}
