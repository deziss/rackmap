import { z } from "zod";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES } from "../constants.js";
import { CursorQuery } from "./common.js";

export const AuditListQuery = CursorQuery.extend({
  category: z.enum(AUDIT_CATEGORIES).optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  actorId: z.string().trim().max(60).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;

export const AuditEntryDto = z.object({
  id: z.number().int(),
  category: z.enum(AUDIT_CATEGORIES),
  action: z.string(),
  entity: z.string().nullable(),
  entityId: z.string().nullable(),
  entityName: z.string().optional(),
  actorId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  diff: z
    .record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }))
    .nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;

export const AuditListResponse = z.object({
  items: z.array(AuditEntryDto),
  nextCursor: z.number().int().nullable(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;
