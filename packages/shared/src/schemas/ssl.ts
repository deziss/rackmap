import { z } from "zod";
import { CursorQuery } from "./common.js";

export const SSL_STATUSES = ["valid", "expiring_soon", "expired", "error", "unknown"] as const;

export const SslStatusCreateInput = z.object({
  domain: z.string().trim().min(1).max(255),
  team: z.string().trim().max(100).nullable().optional(),
  project: z.string().trim().max(100).nullable().optional(),
  serverId: z.number().int().positive().nullable().optional(),
  serviceId: z.number().int().positive().nullable().optional(),
});
export type SslStatusCreateInput = z.infer<typeof SslStatusCreateInput>;

export const SslStatusUpdateInput = SslStatusCreateInput.partial();
export type SslStatusUpdateInput = z.infer<typeof SslStatusUpdateInput>;

export const SslStatusListQuery = CursorQuery.extend({
  q: z.string().trim().max(255).optional(),
  status: z.enum(SSL_STATUSES).optional(),
});
export type SslStatusListQuery = z.infer<typeof SslStatusListQuery>;

export const SslStatusDto = z.object({
  id: z.number().int(),
  domain: z.string(),
  team: z.string().nullable(),
  project: z.string().nullable(),
  server: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  service: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  
  issuer: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  daysRemaining: z.number().int().nullable(),
  
  status: z.string(),
  lastError: z.string().nullable(),
  lastScannedAt: z.string().nullable(),
  isManual: z.boolean(),
  
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SslStatusDto = z.infer<typeof SslStatusDto>;

export const SslStatusListResponse = z.object({
  items: z.array(SslStatusDto),
  nextCursor: z.number().int().nullable(),
  total: z.number().int(),
});
export type SslStatusListResponse = z.infer<typeof SslStatusListResponse>;
