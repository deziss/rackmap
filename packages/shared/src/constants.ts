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

/** URL segment -> display label for the dropdown lookup tables. */
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

export const AUDIT_CATEGORIES = ["data", "auth", "notification", "security"] as const;
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
  "server.auto_discover",
  "server.sudo_permission",
  "server.os_user_create",
  "server.os_user_update",
  "server.os_user_delete",
  "service.create",
  "service.update",
  "service.delete",
  "service.restore",
  "service.password_reveal",
  "lookup.create",
  "lookup.update",
  "lookup.delete",
  "server.recalculate_storage",
  "server.auto_update_change",
  "server.ssh_test_success",
  "server.ssh_test_failed",
  "server.export",
  "service.export",
  "ssl.create",
  "ssl.update",
  "ssl.delete",
  "ssl.restore",
  "ssl.scan_all",
  "ssh_key.add",
  "ssh_key.remove",
  "api_key.create",
  "api_key.revoke",
  "tag.create",
  "tag.delete",
  "vault.init",
  "vault.unlock",
  "vault.lock",
  "vault.reset",
  "vault.unlock_global",
  "vault.lock_global",
  "license.activate",
  "license.deactivate",
  "checkout.complete",
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
  "access_request.delete",
  "email_sent",
  "server.ssh_auth_failed",
  "security.rate_limited",
  "vault.reset_destructive",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
