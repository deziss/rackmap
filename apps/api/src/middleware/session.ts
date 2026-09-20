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

/**
 * Require a valid, non-banned caller. Returns 401 if absent, 403 if banned.
 *
 * If an earlier middleware already established the caller (currently
 * `apiKeyAuth`, mounted globally on /api/v1/*), this yields to it rather than
 * demanding a cookie session — that is what lets a Bearer API key satisfy the
 * same route guards as a browser session.
 */
export async function requireSession(c: Context, next: Next) {
  if (c.get("user")) return next();

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
    // Ban and role changes delete DB sessions but cannot invalidate an already
    // issued cookie cache entry. Read through to the database so a ban takes
    // effect on the next request instead of up to cookieCache.maxAge later.
    query: { disableCookieCache: true },
  });
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

/** Re-exported for existing importers; the implementation lives in lib/client-ip.ts. */
export { getClientIp } from "../lib/client-ip.js";
