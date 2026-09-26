import { z } from "zod";

export const ErrorCode = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL",
  "CRON_CONFLICT",
  "VAULT_LOCKED",
  "SELF_APPROVAL",
  "NOT_LICENSED",
  "PAYLOAD_TOO_LARGE",
  "PUBLIC_BASE_URL_UNSET",
  "NOT_IMPLEMENTED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const IdParam = z.object({
  id: z.coerce.number().int().positive(),
});
export type IdParam = z.infer<typeof IdParam>;

export const CursorQuery = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  sortBy: z.string().max(50).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;
