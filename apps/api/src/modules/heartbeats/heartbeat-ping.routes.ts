import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { HEARTBEAT_TOKEN_PATTERN, type HeartbeatPingKind } from "@inv/shared";
import { env } from "../../env.js";
import { rateLimit, callerIdentity } from "../../middleware/rate-limit.js";
import { getClientIp } from "../../lib/client-ip.js";
import { recordHeartbeatPing } from "../../services/heartbeat-ping.service.js";

/**
 * Heartbeat check-ins — mounted at /api/v1/ping, UNAUTHENTICATED, before apiKeyAuth.
 *
 *   GET|POST /:token            success (or `?rc=N`: 0 = success, else failure)
 *   GET|POST /:token/start      a run began (enables duration tracking)
 *   GET|POST /:token/fail       the run failed
 *   GET|POST /:token/log        a note; never changes status
 *   GET|POST /:token/:rc        exit code 0-255, as the wrapped cron line sends it
 *
 * HEAD is answered by the GET handlers (Hono dispatches HEAD as GET).
 *
 * The token in the path IS the credential, so:
 *  - an unknown token is a plain 404 — never 401, which would invite a client to
 *    retry with credentials it does not have — and it says nothing more;
 *  - the answer is `200 OK` text/plain, so `curl -f` and `wget` exit 0;
 *  - a POST body (job output) is kept up to HEARTBEAT_PING_MAX_BODY_BYTES and the
 *    rest dropped with `bodyTruncated`, rather than refused: a chatty job must not
 *    look down because its log was long. Only an absurd declared length gets 413.
 */

const TOKEN = "{[A-Za-z0-9_-]{22,64}}";
const MINUTE_MS = 60_000;
/** Refuse outright only when the client announces something far past any sane log excerpt. */
const MAX_DECLARED_BODY_BYTES = 1_048_576;

/**
 * Per token (hashed — the raw token never becomes a map key that could leak in a heap
 * dump): a runaway loop in one job cannot flood the ping table.
 */
const tokenLimit = rateLimit({
  windowMs: MINUTE_MS,
  max: 120,
  key: (c) => `hb:${createHash("sha256").update(c.req.param("token") ?? "").digest("hex").slice(0, 16)}`,
  message: "Too many pings for this heartbeat. Try again shortly.",
});

/** Per peer, across tokens: bounds token guessing from one address. */
const peerLimit = rateLimit({
  windowMs: MINUTE_MS,
  max: 600,
  key: (c) => `hbpeer:${callerIdentity(c)}`,
  message: "Too many pings. Try again shortly.",
});

type Mode = "auto" | "start" | "fail" | "log" | "rc";

const RC_PATTERN = /^[0-9]{1,3}$/;

function parseRc(raw: string | undefined): number | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  if (!RC_PATTERN.test(raw)) return "invalid";
  const n = Number(raw);
  return n > 255 ? "invalid" : n;
}

type BodyRead = { body: string | null; truncated: boolean } | "too_large";

/** Read at most `max` bytes of the request body; cancel the rest. */
async function readCappedBody(c: Context, max: number): Promise<BodyRead> {
  if (c.req.method !== "POST") return { body: null, truncated: false };
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DECLARED_BODY_BYTES) return "too_large";

  const stream = c.req.raw.body;
  if (!stream) return { body: null, truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - total;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        total += Math.max(room, 0);
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (total === 0) return { body: null, truncated };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    bytes.set(ch, offset);
    offset += ch.byteLength;
  }
  // Postgres `text` rejects NUL; a cut in the middle of a multi-byte character
  // decodes to U+FFFD rather than failing.
  const body = new TextDecoder("utf-8").decode(bytes).replace(/\u0000/g, "");
  return { body, truncated };
}

function notFound(c: Context) {
  return c.text("Not found", 404);
}

async function handlePing(c: Context, mode: Mode) {
  const token = c.req.param("token") ?? "";
  // Real tokens are exactly 43 chars; anything else cannot exist, so skip the query.
  if (!HEARTBEAT_TOKEN_PATTERN.test(token)) return notFound(c);

  let kind: HeartbeatPingKind;
  let exitCode: number | null = null;
  const rc = parseRc(mode === "rc" ? c.req.param("rc") : c.req.query("rc"));
  if (rc === "invalid") return c.text("rc must be an exit code between 0 and 255", 400);

  switch (mode) {
    case "start":
      kind = "start";
      break;
    case "log":
      kind = "log";
      break;
    case "fail":
      kind = "fail";
      exitCode = rc;
      break;
    default:
      exitCode = rc;
      kind = rc === null || rc === 0 ? "success" : "fail";
  }

  const read = await readCappedBody(c, env.HEARTBEAT_PING_MAX_BODY_BYTES);
  if (read === "too_large") return c.text("Payload too large", 413);

  const outcome = await recordHeartbeatPing({
    token,
    kind,
    exitCode,
    body: read.body,
    bodyTruncated: read.truncated,
    remoteIp: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });
  if (!outcome) return notFound(c);
  return c.text("OK", 200);
}

const methods = ["GET", "POST"];

export const heartbeatPingRoutes = new Hono()
  .on(methods, `/:token${TOKEN}`, tokenLimit, peerLimit, (c) => handlePing(c, "auto"))
  .on(methods, `/:token${TOKEN}/start`, tokenLimit, peerLimit, (c) => handlePing(c, "start"))
  .on(methods, `/:token${TOKEN}/fail`, tokenLimit, peerLimit, (c) => handlePing(c, "fail"))
  .on(methods, `/:token${TOKEN}/log`, tokenLimit, peerLimit, (c) => handlePing(c, "log"))
  .on(methods, `/:token${TOKEN}/:rc{[0-9]{1,3}}`, tokenLimit, peerLimit, (c) => handlePing(c, "rc"));
