export const ROLES = ["admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const SERVER_STATUS = ["up", "down", "unknown"] as const;
export type ServerStatus = (typeof SERVER_STATUS)[number];

export const PROBE_ERROR_CODES = [
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "UNKNOWN",
] as const;
export type ProbeErrorCode = (typeof PROBE_ERROR_CODES)[number];

/** URL segment -> display label for the five dropdown lookup tables. */
export const LOOKUP_TYPES = {
  "cloud-providers": "Cloud Provider",
  "gpu-types": "GPU Type",
  "allocated-to": "Allocated To",
  locations: "Location",
  "server-types": "Server Type",
  "network-types": "Network Type",
} as const;
export type LookupType = keyof typeof LOOKUP_TYPES;
export const LOOKUP_TYPE_KEYS = Object.keys(LOOKUP_TYPES) as LookupType[];

export const AUDIT_CATEGORIES = ["data", "auth"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_ACTIONS = [
  "server.create",
  "server.update",
  "server.delete",
  "server.restore",
  "server.password_reveal",
  "server.update_network",
  "server.reassign",
  "server.import",
  "server.metrics_view",
  "server.ssh_open",
  "server.ssh_close",
  "lookup.create",
  "lookup.update",
  "lookup.delete",
  "ssl.delete",
  "ssl.restore",
  "tag.create",
  "tag.delete",
  "auth.sign_in",
  "auth.sign_in_failed",
  "auth.sign_out",
  "user.create",
  "user.update",
  "user.role_change",
  "user.ban",
  "user.unban",
  "user.remove",
  "auth.password_reset_by_admin",
  "access_request.create",
  "access_request.approved",
  "access_request.rejected",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
