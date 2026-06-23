import { z } from "zod";
import { SERVER_STATUS } from "../constants.js";
import { CursorQuery } from "./common.js";

const lookupRef = z.object({ id: z.number().int(), name: z.string() });

const nullableId = z.number().int().positive().nullable().optional();

export const ServerCreateInput = z.object({
  hostname: z.string().trim().min(1).max(255),
  ip: z.string().trim().min(1).max(255),
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(512).nullable().optional(),
  sshPort: z.number().int().min(1).max(65535).default(22),
  cpu: z.string().trim().max(255).nullable().optional(),
  ram: z.string().trim().max(255).nullable().optional(),
  gpuCount: z.number().int().min(0).max(100_000).nullable().optional(),
  remark: z.string().trim().max(2000).nullable().optional(),
  domain: z.string().trim().max(255).nullable().optional(),
  environment: z.enum(["on-premise", "cloud"]).default("on-premise").optional(),
  cloudProviderId: nullableId,
  gpuTypeId: nullableId,
  allocatedToId: nullableId,
  locationId: nullableId,
  serverTypeId: nullableId,
  tagIds: z.array(z.number().int().positive()).max(50).optional(),
});
export type ServerCreateInput = z.infer<typeof ServerCreateInput>;

/** PATCH body: any subset. `password` omitted = unchanged, null = cleared. */
export const ServerUpdateInput = ServerCreateInput.partial();
export type ServerUpdateInput = z.infer<typeof ServerUpdateInput>;

export const ServerListQuery = CursorQuery.extend({
  q: z.string().trim().max(255).optional(),
  cloudProviderId: z.coerce.number().int().positive().optional(),
  gpuTypeId: z.coerce.number().int().positive().optional(),
  allocatedToId: z.coerce.number().int().positive().optional(),
  locationId: z.coerce.number().int().positive().optional(),
  serverTypeId: z.coerce.number().int().positive().optional(),
  tagId: z.coerce.number().int().positive().optional(),
  status: z.enum(SERVER_STATUS).optional(),
  includeDeleted: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .optional(),
});
export type ServerListQuery = z.infer<typeof ServerListQuery>;

export const ServerDto = z.object({
  id: z.number().int(),
  hostname: z.string(),
  ip: z.string(),
  username: z.string(),
  hasPassword: z.boolean(),
  sshPort: z.number().int(),
  cpu: z.string().nullable(),
  ram: z.string().nullable(),
  gpuCount: z.number().int().nullable(),
  remark: z.string().nullable(),
  domain: z.string().nullable(),
  environment: z.string().nullable(),
  cloudProvider: lookupRef.nullable(),
  gpuType: lookupRef.nullable(),
  allocatedTo: lookupRef.nullable(),
  location: lookupRef.nullable(),
  serverType: lookupRef.nullable(),
  tags: z.array(z.object({ id: z.number().int(), name: z.string(), color: z.string().nullable() })),
  lastStatus: z.enum(SERVER_STATUS),
  lastCheckedAt: z.string().nullable(),
  lastLatencyMs: z.number().int().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedByEmail: z.string().nullable(),
});
export type ServerDto = z.infer<typeof ServerDto>;

export const ServerListResponse = z.object({
  items: z.array(ServerDto),
  nextCursor: z.number().int().nullable(),
  total: z.number().int(),
});
export type ServerListResponse = z.infer<typeof ServerListResponse>;

export const RevealPasswordResponse = z.object({
  password: z.string().nullable(),
});
export type RevealPasswordResponse = z.infer<typeof RevealPasswordResponse>;
