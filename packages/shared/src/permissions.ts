import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";

/**
 * RBAC single source of truth. Imported by the API (server-side checks)
 * and the web app (UI gating) so the two can never drift.
 */
export const statement = {
  ...defaultStatements,
  server: ["create", "update", "delete", "restore", "revealPassword", "check", "import", "metrics", "ssh"],
  lookup: ["create", "update", "delete"],
  tag: ["create", "delete"],
  audit: ["read"],
} as const;

export const ac = createAccessControl(statement);

/** Read-only: every authenticated, non-banned user can read. */
export const viewer = ac.newRole({});

export const editor = ac.newRole({
  server: ["create", "update", "revealPassword", "check", "metrics"],
  lookup: ["create"],
  tag: ["create"],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  server: ["create", "update", "delete", "restore", "revealPassword", "check", "import", "metrics", "ssh"],
  lookup: ["create", "update", "delete"],
  tag: ["create", "delete"],
  audit: ["read"],
});

export const roles = { admin, editor, viewer };

export type PermissionCheck = {
  [K in keyof typeof statement]?: readonly (typeof statement)[K][number][];
};
