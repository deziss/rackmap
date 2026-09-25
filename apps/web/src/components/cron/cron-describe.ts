import cronstrue from "cronstrue";
import { expandCronNickname, validateCronSchedule } from "@inv/shared";

/** Human-readable schedule ("At 03:15, only on Monday"), or null when it does not validate. */
export function describeCronSchedule(schedule: string): string | null {
  const s = schedule.trim();
  if (s === "@reboot") return "At system startup";
  if (!validateCronSchedule(s).ok) return null;
  const expr = expandCronNickname(s);
  if (!expr) return null;
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: true, throwExceptionOnParseError: true });
  } catch {
    return null;
  }
}

export function isValidTimezone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Mon 09 Mar, 03:30" in the given (host) timezone. */
export function formatCronRun(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: isValidTimezone(timezone) ? timezone : "UTC",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}
