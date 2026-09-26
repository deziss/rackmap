import { z } from "zod";
import { PROBE_ERROR_CODES } from "../constants.js";
import { CursorQuery } from "./common.js";

export const StatusCheckDto = z.object({
  id: z.number().int(),
  serverId: z.number().int(),
  status: z.enum(["up", "down"]),
  latencyMs: z.number().int().nullable(),
  errorCode: z.enum(PROBE_ERROR_CODES).nullable(),
  checkedAt: z.string(),
});
export type StatusCheckDto = z.infer<typeof StatusCheckDto>;

export const StatusHistoryQuery = CursorQuery;
export type StatusHistoryQuery = z.infer<typeof StatusHistoryQuery>;

export const StatusHistoryResponse = z.object({
  items: z.array(StatusCheckDto),
  nextCursor: z.number().int().nullable(),
});
export type StatusHistoryResponse = z.infer<typeof StatusHistoryResponse>;

/** Admin clean-up of stored probe history. At least one criterion is required. */
export const StatusHistoryPruneInput = z
  .object({
    /** Delete rows older than this many days (0 = everything before now). */
    olderThanDays: z.number().int().min(0).max(3650).optional(),
    /** Keep only this many of the newest rows (0 = delete all). */
    keepNewest: z.number().int().min(0).max(10_000_000).optional(),
  })
  .refine((v) => v.olderThanDays !== undefined || v.keepNewest !== undefined, {
    message: "Choose an age (olderThanDays) or a row limit (keepNewest)",
  });
export type StatusHistoryPruneInput = z.infer<typeof StatusHistoryPruneInput>;

export const StatusHistoryStats = z.object({
  total: z.number().int(),
  oldest: z.string().nullable(),
  newest: z.string().nullable(),
  servers: z.number().int(),
  retentionDays: z.number().int(),
  maxRows: z.number().int(),
  sampleIntervalMs: z.number().int(),
});
export type StatusHistoryStats = z.infer<typeof StatusHistoryStats>;

export const CheckAllResponse = z.object({
  checked: z.number().int(),
  up: z.number().int(),
  down: z.number().int(),
});
export type CheckAllResponse = z.infer<typeof CheckAllResponse>;
