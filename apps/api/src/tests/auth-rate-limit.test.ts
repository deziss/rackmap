import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../app.js";
import { env } from "../env.js";
import { resetRateLimits } from "../middleware/rate-limit.js";

/**
 * Sign-in throttling has two layers:
 *   - per client IP (Better Auth's limiter, AUTH_LOGIN_RATE_LIMIT_MAX = 60/min),
 *     generous so an office behind one NAT is not locked out;
 *   - per ACCOUNT (auth.ts hook, AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX = 10/min),
 *     which is what actually bounds guessing one user's password.
 *
 * Every failing attempt here uses a throwaway example.com address. The fixture
 * accounts (admin@/editor@/viewer@inventory.local) are shared by every spec in
 * the process through loginAs(), so throttling one would break other files.
 *
 * The per-IP limiter is Better Auth's and is shared across the whole test
 * process, so this file keeps its total sign-in count well under 60.
 */

const app = createApp();

function signIn(email: string, ip = "198.51.100.42") {
  return app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ email, password: "WrongPassword999!" }),
  });
}

beforeEach(() => {
  resetRateLimits();
});

describe("Auth login rate limiting", () => {
  it("keeps the per-IP limit generous and the per-account limit tight", () => {
    expect(env.AUTH_LOGIN_RATE_LIMIT_MAX).toBeGreaterThanOrEqual(50);
    expect(env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX).toBeLessThan(env.AUTH_LOGIN_RATE_LIMIT_MAX);
  });

  it("15 wrong passwords across different accounts from one IP are not throttled", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await signIn(`nobody-${i}@example.com`);
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    // Bad credentials are rejected as such — 400 or 401, never 429.
    expect(statuses.every((s) => s === 400 || s === 401)).toBe(true);
  });

  it("throttles one account after AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX attempts", async () => {
    const max = env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX;
    const target = "brute-force-target@example.com";

    for (let i = 0; i < max; i++) {
      const res = await signIn(target);
      expect(res.status, `attempt ${i + 1} of ${max} must reach the password check`).not.toBe(429);
    }

    // A different letter case is still the same account.
    const blocked = await signIn(target.toUpperCase());
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT_WINDOW);

    // Rotating the source address does not buy more guesses at the same account…
    expect((await signIn(target, "203.0.113.9")).status).toBe(429);

    // …while other accounts are unaffected.
    expect((await signIn("someone-else@example.com")).status).not.toBe(429);
  });
});
