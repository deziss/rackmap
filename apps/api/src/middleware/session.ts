import type { Context, Next } from "hono";
import { auth } from "../auth.js";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
  }
}

type UserWithAdminFields = {
  id: string;
  email: string;
  name: string;
  banned?: boolean | null;
  role?: string | null;
};

/** Require valid, non-banned session. Returns 401 if absent, 403 if banned. */
export async function requireSession(c: Context, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
  }

  const u = session.user as unknown as UserWithAdminFields;
  if (u.banned) {
    return c.json({ error: { code: "FORBIDDEN", message: "Account is banned" } }, 403);
  }

  c.set("user", {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role ?? "viewer",
  });
  return next();
}

/** Extract caller IP (supports X-Forwarded-For). */
export function getClientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}
