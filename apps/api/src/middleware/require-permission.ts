import type { Context, Next } from "hono";
import { can } from "../lib/permissions.js";

/** Returns middleware that requires all specified permissions. */
export function requirePermission(permissions: Record<string, string[]>) {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    }

    for (const [resource, actions] of Object.entries(permissions)) {
      for (const action of actions) {
        if (!can(user.role, resource, action)) {
          return c.json({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } }, 403);
        }
      }
    }

    return next();
  };
}
