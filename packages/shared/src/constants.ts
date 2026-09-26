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
  "ssh_host_key.forget",
  "server.cron_update",
  "server.cron_run",
  "server.cron_monitor",
  "server.cron_unmonitor",
  "alert_channel.create",
  "alert_channel.update",
  "alert_channel.delete",
  "alert_channel.test",
  "heartbeat.create",
  "heartbeat.update",
  "heartbeat.delete",
  "heartbeat.pause",
  "heartbeat.resume",
  "heartbeat.rotate_token",
  "runbook.create",
  "runbook.update",
  "runbook.delete",
  "runbook.run_request",
  "runbook.run_approve",
  "runbook.run_reject",
  "runbook.run_cancel",
  "runbook.run_scheduled",
  "runbook.run_finished",
  "status_history.prune",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Delivery targets an alert channel can post to. */
export const ALERT_CHANNEL_TYPES = ["slack", "teams", "discord", "pagerduty", "telegram", "webhook", "email"] as const;
export type AlertChannelType = (typeof ALERT_CHANNEL_TYPES)[number];

/** Every event the alerting outbox can carry; channels subscribe to a subset. */
export const ALERT_EVENT_TYPES = [
  "server_down",
  "server_up",
  "service_down",
  "service_up",
  "metric_alert",
  "access_request",
  "heartbeat_late",
  "heartbeat_fail",
  "heartbeat_recover",
  "runbook_failed",
  "runbook_succeeded",
  "runbook_approval",
  "ssl_expiring",
  "system",
  "test",
] as const;
export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

export const ALERT_SEVERITIES = ["critical", "error", "warning", "info"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
