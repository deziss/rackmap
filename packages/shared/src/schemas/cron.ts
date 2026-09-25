import { z } from "zod";

/**
 * CONTRACT (Wave 0) — owned by the cron agent, who may ADD schemas here but must
 * keep CronTarget / CronWriteInput stable: the heartbeats agent depends on them.
 *
 * Every field below ends up in a root shell on the managed host, so formats are
 * pinned conservatively and re-checked at the point of interpolation.
 */

// Same format rule as os-user.ts CreateOsUserInput.username.
export const CRON_USERNAME_PATTERN = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/;
// run-parts silently ignores /etc/cron.d files whose names contain a dot.
export const CROND_FILE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const CronTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), user: z.string().min(1).max(32).regex(CRON_USERNAME_PATTERN, "Invalid Linux username") }),
  z.object({ kind: z.literal("system") }),
  z.object({
    kind: z.literal("crond"),
    file: z.string().regex(CROND_FILE_PATTERN, "cron.d file names may only contain letters, digits, '_' and '-'"),
  }),
]);
export type CronTarget = z.infer<typeof CronTarget>;

export const CronWriteInput = z.object({
  target: CronTarget,
  content: z.string().max(65_536),
  /** sha256 hex of the content the client last read ("" hashed when the target did not exist). */
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CronWriteInput = z.infer<typeof CronWriteInput>;

/** sha256 of "" — the baseHash for a target that does not exist yet. */
export const CRON_EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Only RackMap-created cron.d files may be deleted through the editor. */
export const CROND_DELETABLE_PATTERN = /^rackmap-[A-Za-z0-9_-]+$/;

/** PUT /servers/:id/cron — CronWriteInput plus the explicit "delete this cron.d file" flag. */
export const CronSaveInput = CronWriteInput.extend({
  /** With empty content on a `crond` target named rackmap-*: remove the file instead of writing it. */
  deleteFile: z.boolean().optional(),
});
export type CronSaveInput = z.infer<typeof CronSaveInput>;

/** POST /servers/:id/cron/run — run one entry of the target as its user, right now. */
export const CronRunInput = z.object({
  target: CronTarget,
  lineNo: z.number().int().positive().max(100_000),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CronRunInput = z.infer<typeof CronRunInput>;

/** Wire shape of one target in GET /servers/:id/cron (mirrors CronTargetSnapshot in the API). */
export interface CronTargetSnapshotDto {
  target: CronTarget;
  content: string;
  hash: string;
  privileged: boolean;
  /** Why the owner counts as privileged: "uid0", "group:docker", "sudoers", "unknown". */
  privilegeReason?: string;
  /** False when the target does not exist on the host yet. */
  exists?: boolean;
  /** Listed for reference only (ignored by cron, too large, owner gone, …). */
  readOnly?: boolean;
  warning?: string;
  /** Where the target lives on the host, for display. */
  path?: string;
}

export interface CronTimerDto {
  unit: string;
  activates: string;
  next: string | null;
  last: string | null;
}

export interface CronHostSnapshotDto {
  timezone: string;
  targets: CronTargetSnapshotDto[];
  timers: CronTimerDto[];
  warnings?: string[];
}

export interface CronSaveResponse {
  hash: string;
}

export interface CronRunResponse {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}
