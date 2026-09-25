import type { AlertChannelType, AlertEventType, AlertSeverity } from "@inv/shared";
import type { OutboundRule } from "../../lib/outbound-http.js";

/** The event as a formatter sees it (an AlertEvent row, or a synthetic test event). */
export interface FormatEvent {
  id: number;
  type: AlertEventType;
  severity: AlertSeverity;
  action: "trigger" | "resolve" | "info";
  dedupKey: string | null;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  serverId: number | null;
  serviceId: number | null;
  heartbeatId: number | null;
  runbookRunId: number | null;
  createdAt: Date;
}

export interface FormatChannel {
  id: number;
  name: string;
  type: AlertChannelType;
  config: Record<string, unknown>;
}

/** Decrypted contents of AlertChannel.secretEnc. Which keys exist depends on the type. */
export interface ChannelSecret {
  url?: string;
  routingKey?: string;
  botToken?: string;
  hmacSecret?: string;
  headers?: Record<string, string>;
}

export interface FormatContext {
  /** Idempotency key sent as X-Rackmap-Delivery (the AlertDelivery id, or "test-…"). */
  deliveryId: string;
  now: Date;
  /** PUBLIC_BASE_URL without a trailing slash, for "Open in RackMap" links. */
  baseUrl: string | null;
}

export type FormattedRequest =
  | { kind: "http"; rule: OutboundRule; url: string; headers: Record<string, string>; body: string }
  | { kind: "email"; to: string[]; subject: string; html: string; text: string }
  /** Nothing to send for this event on this channel (e.g. a resolve with no dedup key). */
  | { kind: "skip"; reason: string };

export interface Classification {
  ok: boolean;
  retryable: boolean;
  retryAfterMs?: number;
  /** Short, sanitized reason for the delivery log. */
  error?: string;
}

export interface Formatter {
  format(event: FormatEvent, channel: FormatChannel, secret: ChannelSecret, ctx: FormatContext): FormattedRequest;
  classify(status: number, headers: Record<string, string>, body: string, now?: Date): Classification;
}
