import type { Context, Next } from "hono";
import { getClientIp } from "../lib/client-ip.js";
import { getAuditCtx, writeAuditDirect } from "../lib/audit.js";

/**
 * Small, dependency-free, fixed-window rate limiter for the handful of
 * endpoints that are worth automating against: password reveals and the SSH
 * credential test. Everything outside `/api/auth/*` was previously unbounded.
 *
 * SINGLE-PROCESS ONLY — NOT CORRECT UNDER HORIZONTAL SCALING
 * ----------------------------------------------------------
 * All state lives in plain `Map`s inside this process. That is only correct
 * while the API runs as exactly one instance, which is how it ships today:
 * `ecosystem.config.cjs` sets `instances: 1`. If this is ever scaled out —
 * pm2 cluster mode, several containers behind a load balancer — each instance
 * keeps its own counters and the effective limit becomes `max × instances`,
 * silently. A shared store (Redis, or a small table with an atomic upsert) is
 * future work and is a hard prerequisite for running more than one instance.
 * Counters are also lost on restart, so a crash loop resets every budget; for
 * a self-hosted single-node deployment that is an accepted trade-off.
 *
 * KEYED ON THE USER, NEVER ON A CLIENT-SUPPLIED IP
 * ------------------------------------------------
 * Buckets are keyed on the authenticated user id. Every route this is applied
 * to sits behind `requireSession`, so `c.get("user").id` is always present,
 * and — unlike `x-forwarded-for`, which any client can set and rotate freely,
 * minting a fresh bucket on every request — a user id cannot be forged without
 * first defeating authentication. This middleware therefore never reads a
 * forwarded header; see `callerIdentity` for the unauthenticated fallback.
 */

type Bucket = {
  count: number;
  resetAt: number;
  /** Whether this window's first rejection has already been audited. */
  audited: boolean;
};

/** How often expired buckets are swept out of a store (lazy, on request). */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Every store created by `rateLimit`, so tests can reset shared module-level
 * state between cases. The API process itself never calls the reset.
 */
const stores = new Set<Map<string, Bucket>>();

/** Test-only: drop every counter in every limiter. */
export function resetRateLimits(): void {
  for (const store of stores) store.clear();
}

/**
 * Stable, non-spoofable caller identity.
 *
 * With a session, that is the user id. Without one we fall back to the TCP
 * peer address the kernel reports on the underlying socket
 * (`@hono/node-server` exposes the raw `IncomingMessage` on `c.env`).
 * `x-forwarded-for` / `x-real-ip` are deliberately NOT consulted: they are
 * client-supplied, so trusting them hands an attacker an unlimited number of
 * buckets. Behind a reverse proxy the socket address collapses to the proxy's
 * own address, i.e. one shared bucket for all anonymous callers — intentionally
 * conservative, and unreachable in practice because every route using this
 * limiter is mounted behind `requireSession`.
 *
 * The anonymous fallback delegates to `lib/client-ip.ts`, which is the single
 * place that decides whether forwarding headers may be trusted: it honours them
 * only when the operator has set TRUST_PROXY, and otherwise falls back to the
 * same kernel-reported socket address. Behind a trusted proxy that means each
 * real client gets its own bucket instead of everyone sharing the proxy's.
 */
export function callerIdentity(c: Context): string {
  const user = c.get("user") as { id?: string } | undefined;
  if (user?.id) return `u:${user.id}`;
  return `peer:${getClientIp(c)}`;
}

/** Default bucket key: this caller, on this exact route + resource id. */
function defaultKey(c: Context): string {
  return `${callerIdentity(c)}|${c.req.method} ${c.req.path}`;
}

export type RateLimitOptions = {
  /** Fixed window length in milliseconds. */
  windowMs: number;
  /** Requests allowed per key per window. */
  max: number;
  /** Bucket key for a request. Defaults to caller + method + path. */
  key?: (c: Context) => string;
  /** Message returned with the 429. */
  message?: string;
};

/**
 * Returns Hono middleware enforcing `max` requests per `windowMs` per key.
 *
 * Attempts are counted whether or not the downstream handler succeeds: a
 * failed password guess has to cost the attacker the same budget as a
 * successful one, otherwise the limit does not bound guessing at all.
 */
export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, message } = opts;
  const keyOf = opts.key ?? defaultKey;

  const store = new Map<string, Bucket>();
  stores.add(store);
  let lastSweep = Date.now();

  return async (c: Context, next: Next) => {
    const now = Date.now();

    // Evict expired buckets. This process is long-lived and the key space is
    // unbounded (user × resource id), so without this the Map only grows.
    if (now - lastSweep >= SWEEP_INTERVAL_MS) {
      lastSweep = now;
      for (const [k, b] of store) {
        if (b.resetAt <= now) store.delete(k);
      }
    }

    const key = keyOf(c);
    let bucket = store.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs, audited: false };
      store.set(key, bucket);
    }

    const resetAtSec = String(Math.ceil(bucket.resetAt / 1000));

    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfter));
      c.header("X-RateLimit-Limit", String(max));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", resetAtSec);
      // Audit the first block per bucket only. Blocked requests are themselves
      // unbounded, so emitting a row per rejection would let an attacker who
      // keeps hammering flood the audit table — the opposite of useful.
      if (!bucket.audited) {
        bucket.audited = true;
        void writeAuditDirect({
          ctx: getAuditCtx(c),
          category: "security",
          action: "security.rate_limited",
          entity: "RateLimit",
          after: { route: `${c.req.method} ${c.req.path}`, limit: max, windowMs },
        }).catch(() => {
          /* never fail a request because the audit write failed */
        });
      }

      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: message ?? `Too many requests. Try again in ${retryAfter}s.`,
          },
        },
        429,
      );
    }

    bucket.count += 1;
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(max - bucket.count));
    c.header("X-RateLimit-Reset", resetAtSec);
    return next();
  };
}

const MINUTE_MS = 60_000;

/*
 * ---------------------------------------------------------------------------
 * The limits actually applied, and why.
 * ---------------------------------------------------------------------------
 *
 * Password reveal (`POST /servers/:id/reveal-password`,
 * `POST /services/:id/reveal-password`)
 *
 *   What an attacker does: having stolen an editor session — or holding one
 *   approved AccessRequest as a viewer — walk `:id` from 1..N and dump every
 *   stored credential in the fleet. Today that is one scripted loop.
 *
 *   What an operator does: clicks "reveal" on one server, copies the password.
 *   Occasionally repeats it after a bad copy/paste or a page refresh.
 *
 *   So: 5 per server per 5 minutes covers the operator's retries, and a
 *   fleet-wide ceiling of 20 reveals per 5 minutes (240/hour) is what actually
 *   stops enumeration — dumping a 500-server fleet goes from seconds to over
 *   two hours, and leaves 500 `server.password_reveal` audit rows on the way.
 *   Servers and services deliberately share the per-user ceiling: they protect
 *   the same class of secret, so they should share one budget rather than
 *   handing an attacker two.
 *
 * SSH credential test (`POST /ssh-keys/test-server/:serverId`)
 *
 *   What an attacker does: this endpoint reports `success` plus `latencyMs`
 *   per attempt, so it is an online password oracle against a managed host,
 *   usable from any editor session.
 *
 *   What an operator does: adds or repairs a key and tests it a few times in a
 *   row until it works; more frequent than a reveal, but still interactive.
 *
 *   So: 10 per host per 5 minutes (120 guesses/hour/host) and 30 per user per
 *   5 minutes across all hosts. Every attempt already writes
 *   `server.ssh_test_success` / `server.ssh_test_failed`, so what is left after
 *   the limit is slow enough to be noticed in the audit log rather than
 *   completing before anyone looks.
 *
 * Both are per-user-and-resource plus a per-user ceiling. The per-resource
 * limiter is mounted first so that requests it rejects do not also burn the
 * fleet-wide budget.
 */

const REVEAL_WINDOW_MS = 5 * MINUTE_MS;
const SSH_TEST_WINDOW_MS = 5 * MINUTE_MS;

/** Per user, per server/service: bounds hammering one credential. */
export const revealPasswordResourceLimit = rateLimit({
  windowMs: REVEAL_WINDOW_MS,
  max: 5,
  message: "Too many reveal attempts for this record. Try again shortly.",
});

/**
 * Per user, across every server and service: bounds fleet-wide enumeration.
 * One instance shared by the server and service routes on purpose.
 */
export const revealPasswordUserLimit = rateLimit({
  windowMs: REVEAL_WINDOW_MS,
  max: 20,
  key: callerIdentity,
  message: "Too many password reveals. Try again shortly.",
});

/** Per user, per target host: bounds online password guessing against one host. */
export const sshCredentialTestResourceLimit = rateLimit({
  windowMs: SSH_TEST_WINDOW_MS,
  max: 10,
  message: "Too many connectivity tests for this server. Try again shortly.",
});

/** Per user, across every host: bounds spraying one guess across the fleet. */
export const sshCredentialTestUserLimit = rateLimit({
  windowMs: SSH_TEST_WINDOW_MS,
  max: 30,
  key: callerIdentity,
  message: "Too many connectivity tests. Try again shortly.",
});
