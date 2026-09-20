import type { Context } from "hono";
import { env } from "../env.js";

/**
 * Caller IP for audit records and rate-limit keys.
 *
 * `X-Forwarded-For` and `X-Real-IP` are client-supplied and trivially forged:
 * trusting them unconditionally lets a caller write any IP it likes into the
 * audit log and mint a fresh rate-limit bucket per request. They are therefore
 * honoured ONLY when TRUST_PROXY is enabled, which an operator sets when
 * RackMap sits behind a reverse proxy that overwrites those headers.
 *
 * Without a trusted proxy we fall back to the socket's remote address, which
 * the client cannot choose.
 *
 * Lives in its own module rather than in middleware/session.ts because the
 * audit layer needs it, and session -> auth -> audit would otherwise form an
 * import cycle.
 */
export function getClientIp(c: Context): string {
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const real = c.req.header("x-real-ip")?.trim();
    if (real) return real;
  }
  return getSocketAddress(c) ?? "unknown";
}

/** Remote address from the underlying node socket, when the adapter exposes it. */
function getSocketAddress(c: Context): string | null {
  try {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return incoming?.socket?.remoteAddress ?? null;
  } catch {
    return null;
  }
}
