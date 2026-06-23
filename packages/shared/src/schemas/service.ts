import { z } from "zod";
import { SERVER_STATUS } from "../constants.js";
import { CursorQuery } from "./common.js";

export const ServiceCreateInput = z.object({
  serviceName: z.string().trim().min(1).max(255),
  serviceType: z.string().trim().max(100).nullable().optional(),
  serverIp: z.string().trim().max(255).nullable().optional(),
  port: z.string().trim().max(10).nullable().optional(),
  domain: z.string().trim().max(255).nullable().optional(),
  username: z.string().trim().max(120).nullable().optional(),
  password: z.string().min(1).max(512).nullable().optional(),
  documentLink: z.string().trim().max(1000).nullable().optional(),
  project: z.string().trim().max(255).nullable().optional(),
  version: z.string().trim().max(50).nullable().optional(),
  environment: z.string().trim().max(50).nullable().optional(),
  dbName: z.string().trim().max(255).nullable().optional(),
  managedBy: z.string().trim().max(255).nullable().optional(),
  remark: z.string().trim().max(2000).nullable().optional(),
  healthUrl: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(["working", "not_working"]).default("working").optional(),
  tagIds: z.array(z.number().int().positive()).max(50).optional(),
});
export type ServiceCreateInput = z.infer<typeof ServiceCreateInput>;

export const ServiceUpdateInput = ServiceCreateInput.partial();
export type ServiceUpdateInput = z.infer<typeof ServiceUpdateInput>;

export const ServiceListQuery = CursorQuery.extend({
  q: z.string().trim().max(255).optional(),
  tagId: z.coerce.number().int().positive().optional(),
  lastStatus: z.enum(SERVER_STATUS).optional(),
  includeDeleted: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .optional(),
});
export type ServiceListQuery = z.infer<typeof ServiceListQuery>;

export const ServiceDto = z.object({
  id: z.number().int(),
  serviceName: z.string(),
  serviceType: z.string().nullable(),
  serverIp: z.string().nullable(),
  port: z.string().nullable(),
  domain: z.string().nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  documentLink: z.string().nullable(),
  project: z.string().nullable(),
  version: z.string().nullable(),
  environment: z.string().nullable(),
  dbName: z.string().nullable(),
  managedBy: z.string().nullable(),
  remark: z.string().nullable(),
  healthUrl: z.string().nullable(),
  status: z.string().nullable(),
  
  lastStatus: z.enum(SERVER_STATUS),
  lastCheckedAt: z.string().nullable(),
  lastLatencyMs: z.number().int().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string(),
  
  tags: z.array(z.object({ id: z.number().int(), name: z.string(), color: z.string().nullable() })),
});
export type ServiceDto = z.infer<typeof ServiceDto>;

export const ServiceListResponse = z.object({
  items: z.array(ServiceDto),
  nextCursor: z.number().int().nullable(),
  total: z.number().int(),
});
export type ServiceListResponse = z.infer<typeof ServiceListResponse>;
