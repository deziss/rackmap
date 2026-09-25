import { createHmac, timingSafeEqual } from "node:crypto";
import type { FormatChannel, FormatContext, FormatEvent, Formatter } from "../types.js";
import { defaultClassify, eventLink, publicPayload } from "./common.js";

/**
 * Generic JSON webhook.
 *
 * Headers on every request:
 *   X-Rackmap-Event      event type, e.g. "server_down"
 *   X-Rackmap-Delivery   delivery id — stable across retries, use it to deduplicate
 *   X-Rackmap-Timestamp  unix seconds when this attempt was signed
 *   X-Rackmap-Signature  "sha256=" + hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *                        (only when the channel has an HMAC secret)
 *
 * Signing the timestamp together with the body lets a receiver reject replays
 * older than a few minutes without trusting any other header.
 *
 * Body formats (config.format):
 *   "default"   — {version:1, deliveryId, event:{…}, link}
 *   "legacy_v1" — byte-for-byte the bodies NOTIFY_WEBHOOK_URL received before
 *                 alert channels existed (status_flip / access_request), so an
 *                 existing receiver keeps working when its env var becomes a channel
 *   "template"  — a JSON document from config.template, see renderTemplate()
 */

/** What notify.service.ts adapters stash in payload.legacy for the legacy_v1 format. */
export type LegacyPayload =
  | {
      kind: "status_flip";
      type: "server" | "service";
      serverId?: number;
      serviceId?: number;
      hostname: string;
      ip: string;
      port: number;
      from: string;
      to: string;
    }
  | {
      kind: "access_request";
      requestId: number;
      status: string;
      type: string;
      requesterEmail: string;
      hostname: string;
      adminNote: string | null;
      expiresAt: string | null;
    };

/**
 * Rebuilds the historical bodies field by field, in their original key order.
 * It must not spread the stored payload: it round-trips through jsonb, which
 * does not preserve key order.
 */
export function legacyV1Body(event: FormatEvent): string {
  const ts = event.createdAt.toISOString();
  const l = event.payload.legacy as LegacyPayload | undefined;
  if (l?.kind === "status_flip") {
    return JSON.stringify({
      event: "status_flip",
      type: l.type ?? "server",
      serverId: l.serverId,
      serviceId: l.serviceId,
      hostname: l.hostname,
      ip: l.ip,
      port: l.port,
      from: l.from,
      to: l.to,
      ts,
    });
  }
  if (l?.kind === "access_request") {
    return JSON.stringify({
      event: "access_request",
      requestId: l.requestId,
      status: l.status,
      type: l.type,
      requesterEmail: l.requesterEmail,
      hostname: l.hostname,
      adminNote: l.adminNote ?? null,
      expiresAt: l.expiresAt ?? null,
      ts,
    });
  }
  // Event kinds that never went to the legacy webhook: same flat style.
  return JSON.stringify({
    event: event.type,
    severity: event.severity,
    action: event.action,
    title: event.title,
    summary: event.summary,
    serverId: event.serverId ?? undefined,
    serviceId: event.serviceId ?? undefined,
    ts,
  });
}

function eventObject(event: FormatEvent, ctx: FormatContext) {
  return {
    id: event.id,
    type: event.type,
    severity: event.severity,
    action: event.action,
    dedupKey: event.dedupKey,
    title: event.title,
    summary: event.summary,
    serverId: event.serverId,
    serviceId: event.serviceId,
    heartbeatId: event.heartbeatId,
    runbookRunId: event.runbookRunId,
    createdAt: event.createdAt.toISOString(),
    link: eventLink(event, ctx.baseUrl),
  };
}

export function defaultBody(event: FormatEvent, ctx: FormatContext): string {
  return JSON.stringify({
    version: 1,
    deliveryId: ctx.deliveryId,
    event: { ...eventObject(event, ctx), payload: publicPayload(event) },
  });
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const EXACT_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_TEMPLATE_DEPTH = 20;

function resolvePath(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return undefined;
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function interpolate(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Render a user template by walking the parsed JSON tree — never by string
 * substitution on JSON text, so a hostname containing `"}` cannot break out of
 * its string and inject keys.
 *
 * A string leaf that is exactly one placeholder (`"{{payload}}"`) becomes the
 * raw value (object, number, null…); any other string leaf gets each
 * placeholder replaced by its text form. Object keys are never substituted.
 *
 * Placeholders: event.{id,type,severity,action,dedupKey,title,summary,createdAt,
 * serverId,serviceId,heartbeatId,runbookRunId,link}, payload[.key…],
 * channel.{id,name}, delivery.id.
 */
export function renderTemplate(template: unknown, event: FormatEvent, channel: FormatChannel, ctx: FormatContext): unknown {
  const root: Record<string, unknown> = {
    event: eventObject(event, ctx),
    payload: publicPayload(event),
    channel: { id: channel.id, name: channel.name },
    delivery: { id: ctx.deliveryId },
  };
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_TEMPLATE_DEPTH) throw new Error("Template is nested too deeply");
    if (typeof node === "string") {
      const exact = EXACT_PLACEHOLDER.exec(node);
      if (exact) return resolvePath(root, exact[1]!) ?? null;
      return node.replace(PLACEHOLDER, (_m, path: string) => interpolate(resolvePath(root, path)));
    }
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, depth + 1);
      return out;
    }
    return node;
  };
  return walk(template, 0);
}

/** Parse and sanity-check a template string. Throws with a user-facing message. */
export function parseWebhookTemplate(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Template must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("Template must be a JSON object or array");
  return parsed;
}

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** Receiver-side check, exported for tests and as reference code for integrators. */
export function verifyWebhookSignature(secret: string, timestamp: string, rawBody: string, header: string): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export const webhookFormatter: Formatter = {
  format(event, channel, secret, ctx) {
    if (!secret.url) return { kind: "skip", reason: "Channel has no webhook URL" };
    const format = channel.config.format;
    let body: string;
    if (format === "legacy_v1") {
      body = legacyV1Body(event);
    } else if (format === "template" && typeof channel.config.template === "string") {
      body = JSON.stringify(renderTemplate(parseWebhookTemplate(channel.config.template), event, channel, ctx));
    } else {
      body = defaultBody(event, ctx);
    }
    const ts = String(Math.floor(ctx.now.getTime() / 1000));
    const headers: Record<string, string> = {
      ...(secret.headers ?? {}),
      "X-Rackmap-Event": event.type,
      "X-Rackmap-Delivery": ctx.deliveryId,
      "X-Rackmap-Timestamp": ts,
    };
    if (secret.hmacSecret) headers["X-Rackmap-Signature"] = signWebhook(secret.hmacSecret, ts, body);
    return { kind: "http", rule: "webhook", url: secret.url, headers, body };
  },
  classify: defaultClassify,
};
