/**
 * Local, synchronous permission check against the roles defined in @inv/shared.
 * Avoids async HTTP calls inside per-request middleware.
 */
import { roles } from "@inv/shared";

type RoleName = keyof typeof roles;

/** Returns true if the role has the given permission. */
export function can(
  role: string,
  resource: string,
  action: string,
): boolean {
  const roleObj = roles[role as RoleName];
  if (!roleObj) return false;
  const perms = roleObj.statements[resource as keyof typeof roleObj.statements] as readonly string[] | undefined;
  return perms?.includes(action) ?? false;
}

/** Build a flat permission map for the /me endpoint. */
export function buildPermissionMap(role: string): Record<string, boolean> {
  const checks: [string, string, string][] = [
    ["server.create", "server", "create"],
    ["server.update", "server", "update"],
    ["server.delete", "server", "delete"],
    ["server.restore", "server", "restore"],
    ["server.revealPassword", "server", "revealPassword"],
    ["server.import", "server", "import"],
    ["server.metrics", "server", "metrics"],
    ["server.ssh", "server", "ssh"],
    ["server.osUsers", "server", "osUsers"],
    ["server.sudo", "server", "sudo"],
    ["server.cron", "server", "cron"],
    ["alertChannel.read", "alertChannel", "read"],
    ["alertChannel.manage", "alertChannel", "manage"],
    ["heartbeat.read", "heartbeat", "read"],
    ["heartbeat.create", "heartbeat", "create"],
    ["heartbeat.update", "heartbeat", "update"],
    ["heartbeat.delete", "heartbeat", "delete"],
    ["runbook.read", "runbook", "read"],
    ["runbook.create", "runbook", "create"],
    ["runbook.update", "runbook", "update"],
    ["runbook.delete", "runbook", "delete"],
    ["runbook.execute", "runbook", "execute"],
    ["runbook.approve", "runbook", "approve"],
    ["maintenance.manage", "maintenance", "manage"],
    ["server.systemd", "server", "systemd"],
    ["server.patch", "server", "patch"],
    ["drift.read", "drift", "read"],
    ["drift.acknowledge", "drift", "acknowledge"],
    ["accessGrant.read", "accessGrant", "read"],
    ["accessGrant.create", "accessGrant", "create"],
    ["accessGrant.revoke", "accessGrant", "revoke"],
    ["lookup.create", "lookup", "create"],
    ["lookup.update", "lookup", "update"],
    ["lookup.delete", "lookup", "delete"],
    ["tag.create", "tag", "create"],
    ["tag.delete", "tag", "delete"],
    ["audit.read", "audit", "read"],
    ["user.create", "user", "create"],
    ["user.set-role", "user", "set-role"],
    ["user.ban", "user", "ban"],
    ["user.delete", "user", "delete"],
  ];
  return Object.fromEntries(checks.map(([key, r, a]) => [key, can(role, r, a)]));
}
