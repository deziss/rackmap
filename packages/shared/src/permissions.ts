import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";

/**
 * RBAC single source of truth. Imported by the API (server-side checks)
 * and the web app (UI gating) so the two can never drift.
 */
export const statement = {
  ...defaultStatements,
  server: [
    "read",
    "create",
    "update",
    "delete",
    "restore",
    "revealPassword",
    "check",
    "import",
    "metrics",
    "ssh",
    "discover",
    "osUsers",
    "sudo",
    "logs",
    "atop",
    "cron",
    "systemd",
    "patch",
  ],
  lookup: ["create", "update", "delete"],
  tag: ["create", "delete"],
  audit: ["read"],
  vault: ["init", "unlock", "status", "reset", "unlockGlobal", "persist"],
  alertChannel: ["read", "manage"],
  heartbeat: ["read", "create", "update", "delete"],
  runbook: ["read", "create", "update", "delete", "execute", "approve"],
  maintenance: ["manage"],
  drift: ["read", "acknowledge"],
  accessGrant: ["read", "create", "revoke"],
} as const;

export const ac = createAccessControl(statement);

/** Read-only: every authenticated, non-banned user can read. */
export const viewer = ac.newRole({
  server: ["read"],
  vault: ["status"],
  heartbeat: ["read"],
});

export const editor = ac.newRole({
  server: ["read", "create", "update", "revealPassword", "check", "metrics", "discover", "osUsers", "logs", "atop", "cron", "systemd", "patch"],
  lookup: ["create", "update"],
  tag: ["create"],
  vault: ["unlock", "status"],
  alertChannel: ["read"],
  heartbeat: ["read", "create", "update"],
  runbook: ["read", "execute"],
  drift: ["read", "acknowledge"],
  accessGrant: ["read", "create"],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  server: [
    "read",
    "create",
    "update",
    "delete",
    "restore",
    "revealPassword",
    "check",
    "import",
    "metrics",
    "ssh",
    "discover",
    "osUsers",
    "sudo",
    "logs",
    "atop",
    "cron",
    "systemd",
    "patch",
  ],
  lookup: ["create", "update", "delete"],
  tag: ["create", "delete"],
  audit: ["read"],
  vault: ["init", "unlock", "status", "reset", "unlockGlobal", "persist"],
  alertChannel: ["read", "manage"],
  heartbeat: ["read", "create", "update", "delete"],
  runbook: ["read", "create", "update", "delete", "execute", "approve"],
  maintenance: ["manage"],
  drift: ["read", "acknowledge"],
  accessGrant: ["read", "create", "revoke"],
});

export const roles = { admin, editor, viewer };

export type PermissionCheck = {
  [K in keyof typeof statement]?: readonly (typeof statement)[K][number][];
};
