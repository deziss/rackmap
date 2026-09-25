import type { AppType } from "../app.js";

/** "admin2" is a second admin account, for four-eyes checks (approver ≠ requester). */
export type Role = "admin" | "admin2" | "editor" | "viewer";

const passwords: Record<Role, string> = {
  admin: "Admin123!",
  admin2: "Admin2-123!",
  editor: "Editor123!",
  viewer: "Viewer123!",
};

const emails: Record<Role, string> = {
  admin: "admin@inventory.local",
  admin2: "admin2@inventory.local",
  editor: "editor@inventory.local",
  viewer: "viewer@inventory.local",
};

/**
 * Cached session cookie per role.
 *
 * vitest runs every spec in one process (`pool: forks, singleFork`), so all
 * files share a single Better Auth rate limiter — and /sign-in/email is capped
 * at 10 per 60s. With a login in each suite's beforeAll the suite began
 * tripping its own limiter and failing to collect with 429, hitting a
 * different victim on each run. Signing in once per role fixes that at the
 * source instead of relaxing the production limit for tests.
 *
 * Keyed on the process global so it is shared across spec files.
 */
const COOKIE_CACHE = Symbol.for("rackmap.test.sessionCookies");
const cookieStore: Map<Role, string> =
  ((globalThis as Record<symbol, unknown>)[COOKIE_CACHE] as Map<Role, string>) ??
  ((globalThis as Record<symbol, unknown>)[COOKIE_CACHE] = new Map<Role, string>());

/**
 * Sign in and return a cookie header string for subsequent requests.
 *
 * Pass `{ fresh: true }` when a test genuinely needs a new session — for
 * example to assert that a ban invalidates one.
 */
export async function loginAs(app: AppType, role: Role, opts?: { fresh?: boolean }): Promise<string> {
  if (!opts?.fresh) {
    const cached = cookieStore.get(role);
    if (cached) return cached;
  }

  const cookie = await signIn(app, role);
  if (!opts?.fresh) cookieStore.set(role, cookie);
  return cookie;
}

async function signIn(app: AppType, role: Role): Promise<string> {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emails[role], password: passwords[role] }),
  });
  if (!res.ok) {
    throw new Error(`loginAs(${role}) failed: ${res.status} ${await res.text()}`);
  }
  // Extract Set-Cookie header
  const raw = res.headers.get("set-cookie") ?? "";
  // Return as Cookie header value (strip directives)
  return raw
    .split(",")
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
}

export function authHeader(cookie: string) {
  return { Cookie: cookie };
}
