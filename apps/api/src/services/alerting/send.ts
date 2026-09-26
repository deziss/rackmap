import type { AlertChannel, AlertEvent } from "@prisma/client";
import type { AlertChannelType, AlertEventType, AlertSeverity } from "@inv/shared";
import { env } from "../../env.js";
import {
  getOutboundPolicy,
  OutboundBlockedError,
  OutboundNetworkError,
  postJson,
  type OutboundPolicy,
} from "../../lib/outbound-http.js";
import { EmailNotConfiguredError, sendEmailOrThrow } from "../email.service.js";
import { sanitizeError } from "./formatters/common.js";
import type { FormatChannel, FormatEvent, Formatter, FormattedRequest } from "./types.js";

/**
 * Outbound policy for one channel. Env-managed channels (NOTIFY_WEBHOOK_URL,
 * NOTIFY_TELEGRAM_*) are operator configuration that already posted to any
 * URL before channels existed — often an internal http:// receiver — so they
 * keep private/http access. The always-blocked ranges (link-local, metadata,
 * multicast) apply to them like to everything else.
 */
export function policyForChannel(ch: { managedBy: string }, base: OutboundPolicy = getOutboundPolicy()): OutboundPolicy {
  return ch.managedBy === "env" ? { ...base, allowPrivate: true, allowHttp: true } : base;
}

export function publicBaseUrl(): string | null {
  return env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, "") : null;
}

export function toFormatEvent(row: AlertEvent): FormatEvent {
  return {
    id: row.id,
    type: row.type as AlertEventType,
    severity: row.severity as AlertSeverity,
    action: (row.action === "trigger" || row.action === "resolve" ? row.action : "info") as FormatEvent["action"],
    dedupKey: row.dedupKey,
    title: row.title,
    summary: row.summary,
    payload: row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {},
    serverId: row.serverId,
    serviceId: row.serviceId,
    heartbeatId: row.heartbeatId,
    runbookRunId: row.runbookRunId,
    createdAt: row.createdAt,
  };
}

export function toFormatChannel(row: Pick<AlertChannel, "id" | "name" | "type" | "config">): FormatChannel {
  return {
    id: row.id,
    name: row.name,
    type: row.type as AlertChannelType,
    config: row.config && typeof row.config === "object" && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {},
  };
}

export interface SendOutcome {
  ok: boolean;
  retryable: boolean;
  statusCode: number | null;
  retryAfterMs?: number;
  /** Sanitized — never contains the URL, token or secret headers. */
  error: string | null;
}

/** Perform one formatted request (HTTP or SMTP) and classify the result. */
export async function sendFormatted(
  req: Exclude<FormattedRequest, { kind: "skip" }>,
  formatter: Formatter,
  policy: OutboundPolicy,
  now: Date = new Date(),
): Promise<SendOutcome> {
  if (req.kind === "email") {
    try {
      await sendEmailOrThrow({ to: req.to, subject: req.subject, html: req.html, text: req.text });
      return { ok: true, retryable: false, statusCode: null, error: null };
    } catch (err) {
      if (err instanceof EmailNotConfiguredError) {
        return { ok: false, retryable: false, statusCode: null, error: "SMTP is not configured (SMTP_HOST)" };
      }
      const code = (err as { responseCode?: number }).responseCode;
      // 5xx SMTP replies are permanent (bad mailbox, rejected); anything else is worth a retry.
      const permanent = typeof code === "number" && code >= 500 && code < 600;
      return {
        ok: false,
        retryable: !permanent,
        statusCode: typeof code === "number" ? code : null,
        error: sanitizeError(`SMTP: ${(err as Error).message}`),
      };
    }
  }

  try {
    const res = await postJson(req.url, req.body, {
      rule: req.rule,
      headers: req.headers,
      timeoutMs: env.ALERT_OUTBOUND_TIMEOUT_MS,
      policy,
    });
    const c = formatter.classify(res.status, res.headers, res.body, now);
    return {
      ok: c.ok,
      retryable: c.retryable,
      statusCode: res.status,
      retryAfterMs: c.retryAfterMs,
      error: c.ok ? null : sanitizeError(c.error ?? `HTTP ${res.status}`),
    };
  } catch (err) {
    if (err instanceof OutboundBlockedError) {
      return { ok: false, retryable: false, statusCode: null, error: `Blocked: ${err.message}` };
    }
    if (err instanceof OutboundNetworkError) {
      return { ok: false, retryable: true, statusCode: null, error: err.message };
    }
    return { ok: false, retryable: true, statusCode: null, error: sanitizeError((err as Error).message ?? "send failed") };
  }
}
