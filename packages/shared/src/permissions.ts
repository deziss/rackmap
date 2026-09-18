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
  ],
  lookup: ["create", "update", "delete"],
  tag: ["create", "delete"],
  audit: ["read"],
  vault: ["init", "unlock", "status", "reset"],
} as const;

export const ac = createAccessControl(statement);

/** Read-only: every authenticated, non-banned user can read. */
export const viewer = ac.newRole({
  server: ["read"],
  vault: ["status"],
});

export const editor = ac.newRole({
  server: ["read", "create", "update", "revealPassword", "check", "metrics", "discover", "osUsers", "logs", "atop"],
  lookup: ["create", "update"],
  tag: ["create"],
  vault: ["unlock", "status"],
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
  ],
  lookup: ["create", "update", "delete"],
  tag: ["create", "delete"],
  audit: ["read"],
  vault: ["init", "unlock", "status", "reset"],
});

export const roles = { admin, editor, viewer };

export type PermissionCheck = {
  [K in keyof typeof statement]?: readonly (typeof statement)[K][number][];
};
