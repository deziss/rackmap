import { ALERT_EVENT_LABELS } from "@inv/shared";
import type { Classification, FormatEvent } from "../types.js";

/** Shared helpers for the channel formatters. Everything here is pure. */

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function severityEmoji(e: Pick<FormatEvent, "severity" | "action">): string {
  if (e.action === "resolve") return "✅";
  switch (e.severity) {
    case "critical":
      return "🔴";
    case "error":
      return "🟠";
    case "warning":
      return "🟡";
    default:
      return "ℹ️";
  }
}

/** RGB integer for embeds (Discord) and a matching Adaptive Card color name (Teams). */
export function severityColor(e: Pick<FormatEvent, "severity" | "action">): { rgb: number; adaptive: string } {
  if (e.action === "resolve") return { rgb: 0x10b981, adaptive: "Good" };
  switch (e.severity) {
    case "critical":
      return { rgb: 0xef4444, adaptive: "Attention" };
    case "error":
      return { rgb: 0xf97316, adaptive: "Attention" };
    case "warning":
      return { rgb: 0xf59e0b, adaptive: "Warning" };
    default:
      return { rgb: 0x3b82f6, adaptive: "Accent" };
  }
}

export function eventTitle(e: FormatEvent): string {
  return e.action === "resolve" && !/^resolved\b/i.test(e.title) ? `Resolved: ${e.title}` : e.title;
}

export function eventTypeLabel(e: Pick<FormatEvent, "type">): string {
  return ALERT_EVENT_LABELS[e.type] ?? e.type;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Hostname-ish source of the event, for PagerDuty `source` and chat context lines. */
export function eventSource(e: FormatEvent): string | null {
  return str(e.payload.hostname) ?? str(e.payload.domain) ?? str(e.payload.serviceName) ?? null;
}

/** Small label/value list shown as fields/facts. Only well-known scalar payload keys. */
export function eventFacts(e: FormatEvent): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [{ label: "Severity", value: e.severity }];
  const known: [string, string][] = [
    ["hostname", "Host"],
    ["ip", "IP"],
    ["environment", "Environment"],
    ["domain", "Domain"],
    ["daysRemaining", "Days remaining"],
    ["metric", "Metric"],
  ];
  for (const [key, label] of known) {
    const v = str(e.payload[key]);
    if (v) facts.push({ label, value: truncate(v, 200) });
  }
  return facts;
}

/** Deep link into the web app, when PUBLIC_BASE_URL is configured. */
export function eventLink(e: FormatEvent, baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  if (e.serverId) return `${baseUrl}/servers/${e.serverId}`;
  if (e.heartbeatId) return `${baseUrl}/heartbeats/${e.heartbeatId}`;
  if (e.runbookRunId) return `${baseUrl}/runbooks/runs/${e.runbookRunId}`;
  if (e.serviceId) return `${baseUrl}/services`;
  if (e.type === "ssl_expiring") return `${baseUrl}/ssl`;
  if (e.type === "access_request") return `${baseUrl}/access-requests`;
  return baseUrl;
}

/** Payload minus internal keys, for machine consumers (webhook body, PagerDuty custom_details). */
export function publicPayload(e: FormatEvent): Record<string, unknown> {
  const { legacy: _legacy, ...rest } = e.payload;
  return rest;
}

/** Escape for HTML text and attribute contexts (email, Telegram HTML mode). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Retry-After: delta-seconds or an HTTP-date. Capped at 6h so one header cannot park a row forever. */
export function parseRetryAfter(value: string | undefined, now: Date = new Date()): number | undefined {
  if (!value) return undefined;
  const cap = 6 * 60 * 60 * 1000;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(Math.ceil(secs * 1000), cap);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - now.getTime()), cap);
  return undefined;
}

/** Strip anything URL- or token-shaped and bound the length: safe for lastError and the UI. */
export function sanitizeError(s: string, max = 1000): string {
  return truncate(
    s
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/\b\d{3,20}:[A-Za-z0-9_-]{20,}\b/g, "[token]")
      .replace(/[\r\n\t]+/g, " ")
      .trim(),
    max,
  );
}

function bodySnippet(body: string): string {
  return sanitizeError(body, 200);
}

/**
 * HTTP status → outcome, shared by every formatter:
 *   2xx ok · 3xx failed (redirects are never followed) · 408/429 retry ·
 *   other 4xx permanent (bad URL, revoked token, bad payload) · 5xx retry.
 */
export function defaultClassify(status: number, headers: Record<string, string>, body: string, now?: Date): Classification {
  if (status >= 200 && status < 300) return { ok: true, retryable: false };
  const snippet = bodySnippet(body);
  const error = `HTTP ${status}${snippet ? `: ${snippet}` : ""}`;
  if (status >= 300 && status < 400) return { ok: false, retryable: false, error: `HTTP ${status}: redirect not followed` };
  if (status === 408 || status === 429 || status >= 500 || status === 0) {
    return { ok: false, retryable: true, retryAfterMs: parseRetryAfter(headers["retry-after"], now), error };
  }
  return { ok: false, retryable: false, error };
}
