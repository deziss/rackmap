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

export const CheckAllResponse = z.object({
  checked: z.number().int(),
  up: z.number().int(),
  down: z.number().int(),
});
export type CheckAllResponse = z.infer<typeof CheckAllResponse>;
