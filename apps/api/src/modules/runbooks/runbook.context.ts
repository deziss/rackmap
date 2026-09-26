import type { Context } from "hono";
import { getAuditCtx } from "../../lib/audit.js";
import { callerIdentity, rateLimit } from "../../middleware/rate-limit.js";
import type { Caller } from "./runbook.service.js";

/** Who is calling, whether through an API key, and the audit context. */
export function callerOf(c: Context): Caller {
  return {
    user: c.get("user"),
    // apiKeyAuth attaches the key owner as `user`; the header is what tells the two apart.
    viaApiKey: c.req.header("Authorization")?.startsWith("Bearer sk_") ?? false,
    audit: getAuditCtx(c),
  };
}

/**
 * 10 run requests per minute per user, shared by POST /runbooks/:id/runs and
 * POST /runbook-runs/:id/rerun: each one can fan out to hundreds of hosts.
 */
export const runRequestLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  key: (c) => `runbook-run|${callerIdentity(c)}`,
  message: "Too many runbook runs requested. Try again in a minute.",
});
