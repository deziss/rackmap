import { z } from "zod";
import { CronTarget } from "./cron.js";

/**
 * Cron heartbeat monitoring (D1).
 *
 * A heartbeat is a dead-man's switch: a job pings `<PUBLIC_BASE_URL>/api/v1/ping/<token>`
 * when it runs, and RackMap alerts when the ping stops arriving on schedule or
 * reports a failure. The token is the only credential a ping carries, so it is never
 * part of a DTO — it is returned exactly once on create / rotate, and re-displayed
 * (via `pingUrl`) only to callers who could rotate it anyway.
 */

export const HEARTBEAT_STATUSES = ["new", "up", "late", "down", "paused"] as const;
export const HeartbeatStatus = z.enum(HEARTBEAT_STATUSES);
export type HeartbeatStatus = z.infer<typeof HeartbeatStatus>;

export const HEARTBEAT_KINDS = ["cron", "period"] as const;
export const HeartbeatKind = z.enum(HEARTBEAT_KINDS);
export type HeartbeatKind = z.infer<typeof HeartbeatKind>;

export const HEARTBEAT_PING_KINDS = ["success", "start", "fail", "log"] as const;
export const HeartbeatPingKind = z.enum(HEARTBEAT_PING_KINDS);
export type HeartbeatPingKind = z.infer<typeof HeartbeatPingKind>;

/** 32 random bytes, base64url without padding. */
export const HEARTBEAT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Upper bounds shared by the API and the form: a week of grace/runtime, a year of period. */
export const HEARTBEAT_MAX_GRACE_SECONDS = 7 * 24 * 3600;
export const HEARTBEAT_MAX_PERIOD_SECONDS = 366 * 24 * 3600;

/** True when `tz` is an IANA zone this runtime can format in (works in node and browsers). */
export function isValidHeartbeatTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const HEARTBEAT_CRON_NICKNAMES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

// One comma-separated item of a vixie/cronie field: `*`, a number or a 3-letter name,
// an optional range end, an optional step. Deliberately excludes croner-only syntax
// (L, W, #, ?) that cron itself would silently ignore.
const HEARTBEAT_CRON_ITEM = /^(?:\*|[0-9]{1,2}|[A-Za-z]{3})(?:-(?:[0-9]{1,2}|[A-Za-z]{3}))?(?:\/[0-9]{1,2})?$/;

/**
 * Expand a nickname to its 5-field form and check the shape of the expression.
 * `@reboot` is refused: it has no next run, so a heartbeat on it could never be late.
 * Returns the 5-field expression, or an error message.
 */
export function normalizeHeartbeatSchedule(schedule: string): { ok: true; expr: string } | { ok: false; error: string } {
  const s = schedule.trim().replace(/\s+/g, " ");
  if (s === "@reboot") return { ok: false, error: "@reboot jobs cannot be monitored on a schedule" };
  if (s.startsWith("@")) {
    const expr = HEARTBEAT_CRON_NICKNAMES[s.toLowerCase()];
    return expr ? { ok: true, expr } : { ok: false, error: `Unknown schedule nickname "${s}"` };
  }
  const fields = s.split(" ");
  if (fields.length !== 5) return { ok: false, error: "A schedule has exactly 5 fields: minute hour day-of-month month day-of-week" };
  for (const field of fields) {
    for (const item of field.split(",")) {
      if (!HEARTBEAT_CRON_ITEM.test(item)) return { ok: false, error: `Unsupported cron syntax "${field}"` };
    }
  }
  return { ok: true, expr: s };
}

const Timezone = z.string().trim().min(1).max(64).refine(isValidHeartbeatTimeZone, "Unknown IANA time zone");
const Schedule = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .superRefine((v, ctx) => {
    const r = normalizeHeartbeatSchedule(v);
    if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
  });

const HeartbeatFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  serverId: z.number().int().positive().nullable().optional(),
  kind: HeartbeatKind.default("cron"),
  schedule: Schedule.nullable().optional(),
  timezone: Timezone.default("UTC"),
  periodSeconds: z.number().int().min(60).max(HEARTBEAT_MAX_PERIOD_SECONDS).nullable().optional(),
  graceSeconds: z.number().int().min(0).max(HEARTBEAT_MAX_GRACE_SECONDS).default(300),
  maxRuntimeSeconds: z.number().int().min(1).max(HEARTBEAT_MAX_GRACE_SECONDS).nullable().optional(),
  resumeOnPing: z.boolean().default(true),
  notifyOnLate: z.boolean().default(false),
});

export const HeartbeatCreateInput = HeartbeatFields.superRefine((v, ctx) => {
  if (v.kind === "cron" && !v.schedule) ctx.addIssue({ code: "custom", path: ["schedule"], message: "A cron heartbeat needs a schedule" });
  if (v.kind === "period" && !v.periodSeconds) ctx.addIssue({ code: "custom", path: ["periodSeconds"], message: "A period heartbeat needs a period" });
});
export type HeartbeatCreateInput = z.infer<typeof HeartbeatCreateInput>;

/** PATCH: every field optional; the kind/schedule/period combination is re-checked against the stored row. */
export const HeartbeatUpdateInput = z.object({
  name: HeartbeatFields.shape.name.optional(),
  description: HeartbeatFields.shape.description,
  serverId: HeartbeatFields.shape.serverId,
  kind: HeartbeatKind.optional(),
  schedule: HeartbeatFields.shape.schedule,
  timezone: Timezone.optional(),
  periodSeconds: HeartbeatFields.shape.periodSeconds,
  graceSeconds: z.number().int().min(0).max(HEARTBEAT_MAX_GRACE_SECONDS).optional(),
  maxRuntimeSeconds: HeartbeatFields.shape.maxRuntimeSeconds,
  resumeOnPing: z.boolean().optional(),
  notifyOnLate: z.boolean().optional(),
});
export type HeartbeatUpdateInput = z.infer<typeof HeartbeatUpdateInput>;

export const HeartbeatListQuery = z.object({
  serverId: z.coerce.number().int().positive().optional(),
  status: HeartbeatStatus.optional(),
});
export type HeartbeatListQuery = z.infer<typeof HeartbeatListQuery>;

export const HeartbeatPingsQuery = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type HeartbeatPingsQuery = z.infer<typeof HeartbeatPingsQuery>;

export const HeartbeatRotateInput = z
  .object({
    /** Also rewrite the monitored crontab line so it pings with the new token. */
    rewriteCron: z.boolean().default(false),
  })
  .default({ rewriteCron: false });
export type HeartbeatRotateInput = z.infer<typeof HeartbeatRotateInput>;

/** What the cron editor stored when it wrapped a crontab line. */
export const HeartbeatCronSource = z.object({
  target: CronTarget,
  originalCommand: z.string(),
  label: z.string(),
  /** The `# rackmap:` label line was added by monitoring (removed again on unmonitor). */
  labelLineInserted: z.boolean().optional(),
});
export type HeartbeatCronSource = z.infer<typeof HeartbeatCronSource>;

export interface HeartbeatPingSummary {
  kind: HeartbeatPingKind;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface HeartbeatPingDto extends HeartbeatPingSummary {
  id: number;
  remoteIp: string | null;
  userAgent: string | null;
  /** Only returned to callers with heartbeat:update — job output can carry secrets. */
  body: string | null;
  bodyTruncated: boolean;
}

export interface HeartbeatDto {
  id: number;
  name: string;
  description: string | null;
  /** First characters of the token, to tell tokens apart after a rotation. */
  tokenPrefix: string;
  serverId: number | null;
  server: { id: number; hostname: string; ip: string; lastStatus: string } | null;
  kind: HeartbeatKind;
  schedule: string | null;
  timezone: string;
  periodSeconds: number | null;
  graceSeconds: number;
  maxRuntimeSeconds: number | null;
  status: HeartbeatStatus;
  resumeOnPing: boolean;
  notifyOnLate: boolean;
  lastPingAt: string | null;
  lastPingKind: HeartbeatPingKind | null;
  lastStartAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastExitCode: number | null;
  lastDurationMs: number | null;
  expectedAt: string | null;
  alertAt: string | null;
  cronSource: HeartbeatCronSource | null;
  createdAt: string;
  updatedAt: string;
  /** Newest first; present on list responses (sparkline). */
  recentPings?: HeartbeatPingSummary[];
}

export interface HeartbeatListResponse {
  items: HeartbeatDto[];
  total: number;
  meta: HeartbeatConfigResponse;
}

export interface HeartbeatConfigResponse {
  /** PUBLIC_BASE_URL is set, so ping URLs (and cron monitoring) are available. */
  pingUrlsAvailable: boolean;
  /** `<PUBLIC_BASE_URL>/api/v1/ping`, or null. */
  pingBaseUrl: string | null;
}

export interface HeartbeatDetailResponse {
  heartbeat: HeartbeatDto;
  /** Newest first, at most 50. */
  pings: HeartbeatPingDto[];
  /** Only for callers with heartbeat:update, and only when PUBLIC_BASE_URL is set. */
  pingUrl: string | null;
  /** The raw token, same visibility rule as pingUrl (for usage snippets). */
  token: string | null;
}

export interface HeartbeatCreatedResponse {
  heartbeat: HeartbeatDto;
  /** Shown once. Store it in the job — it is the only credential a ping carries. */
  token: string;
  pingUrl: string | null;
  warning?: string;
}

export interface HeartbeatPingsResponse {
  items: HeartbeatPingDto[];
  nextCursor: number | null;
}

// ─── Cron editor integration ────────────────────────────────────────────────

export const HeartbeatMonitorInput = z.object({
  target: CronTarget,
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  lineNo: z.number().int().positive(),
  graceSeconds: z.number().int().min(0).max(HEARTBEAT_MAX_GRACE_SECONDS).default(300),
  measureDuration: z.boolean().default(false),
  name: z.string().trim().min(1).max(120).optional(),
  notifyOnLate: z.boolean().optional(),
});
export type HeartbeatMonitorInput = z.infer<typeof HeartbeatMonitorInput>;

export const HeartbeatUnmonitorInput = z.object({
  target: CronTarget,
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  lineNo: z.number().int().positive(),
  /** Delete the heartbeat (admin); otherwise it is paused and unlinked from the line. */
  deleteHeartbeat: z.boolean().default(false),
});
export type HeartbeatUnmonitorInput = z.infer<typeof HeartbeatUnmonitorInput>;

export interface HeartbeatMonitorResponse {
  heartbeat: HeartbeatDto;
  /** sha256 of the crontab as written — the next baseHash. */
  hash: string;
  pingUrl: string | null;
}

export interface HeartbeatUnmonitorResponse {
  hash: string;
  heartbeatId: number | null;
  heartbeatDeleted: boolean;
}
