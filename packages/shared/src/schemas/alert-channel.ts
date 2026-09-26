import { z } from "zod";
import {
  ALERT_CHANNEL_TYPES,
  ALERT_EVENT_TYPES,
  ALERT_SEVERITIES,
  type AlertChannelType,
  type AlertEventType,
  type AlertSeverity,
} from "../constants.js";

/**
 * Pluggable alert channels (Settings → Alerts).
 *
 * Secrets (webhook URLs, routing keys, bot tokens, HMAC secrets, custom headers)
 * travel only in create/update INPUTS. They are write-only: no DTO below carries
 * one, the API stores them v3-encrypted and hands back a masked `secretHint`.
 */

export const AlertChannelTypeSchema = z.enum(ALERT_CHANNEL_TYPES);
export const AlertEventTypeSchema = z.enum(ALERT_EVENT_TYPES);
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);

export const ALERT_DELIVERY_STATUSES = [
  "pending",
  "sending",
  "retrying",
  "succeeded",
  "failed",
  "expired",
  "suppressed",
] as const;
export type AlertDeliveryStatus = (typeof ALERT_DELIVERY_STATUSES)[number];

/** Channel types that need the `multi_channel_alerts` license feature. */
export const ALERT_PRO_CHANNEL_TYPES: readonly AlertChannelType[] = ["teams", "pagerduty"];
/** UI-created channels allowed without `multi_channel_alerts` (env-managed channels are extra). */
export const ALERT_FREE_UI_CHANNEL_LIMIT = 1;

export const ALERT_CHANNEL_TYPE_LABELS: Record<AlertChannelType, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  discord: "Discord",
  pagerduty: "PagerDuty",
  telegram: "Telegram",
  webhook: "Webhook",
  email: "Email",
};

export const ALERT_EVENT_LABELS: Record<AlertEventType, string> = {
  server_down: "Server down",
  server_up: "Server recovered",
  service_down: "Service down",
  service_up: "Service recovered",
  metric_alert: "Metric threshold (CPU/RAM/disk/GPU)",
  access_request: "Access requests",
  heartbeat_late: "Heartbeat late",
  heartbeat_fail: "Heartbeat failed / missed",
  heartbeat_recover: "Heartbeat recovered",
  runbook_failed: "Runbook failed",
  runbook_succeeded: "Runbook succeeded",
  runbook_approval: "Runbook awaiting approval",
  ssl_expiring: "SSL certificate expiring",
  system: "System notices",
  test: "Test alerts",
};

/** Grouping used by the channel dialog's event checkboxes. */
export const ALERT_EVENT_GROUPS: { label: string; events: AlertEventType[] }[] = [
  { label: "Servers & services", events: ["server_down", "server_up", "service_down", "service_up"] },
  { label: "Metrics & certificates", events: ["metric_alert", "ssl_expiring"] },
  { label: "Cron heartbeats", events: ["heartbeat_late", "heartbeat_fail", "heartbeat_recover"] },
  { label: "Runbooks", events: ["runbook_failed", "runbook_succeeded", "runbook_approval"] },
  { label: "Access & system", events: ["access_request", "system", "test"] },
];

const CHAT_DEFAULT_EVENTS: AlertEventType[] = [
  "server_down",
  "server_up",
  "service_down",
  "service_up",
  "metric_alert",
  "ssl_expiring",
  "heartbeat_fail",
  "heartbeat_recover",
  "runbook_failed",
  "runbook_approval",
  "access_request",
  "system",
  "test",
];

/**
 * Suggested subscriptions for a new channel. PagerDuty only gets incident-shaped
 * events (every trigger there pages a human), and every trigger it gets has a
 * matching resolve so incidents close themselves.
 */
export const DEFAULT_ALERT_EVENTS: Record<AlertChannelType, AlertEventType[]> = {
  slack: CHAT_DEFAULT_EVENTS,
  teams: CHAT_DEFAULT_EVENTS,
  discord: CHAT_DEFAULT_EVENTS,
  telegram: CHAT_DEFAULT_EVENTS,
  email: CHAT_DEFAULT_EVENTS,
  pagerduty: [
    "server_down",
    "server_up",
    "service_down",
    "service_up",
    "heartbeat_fail",
    "heartbeat_recover",
    "runbook_failed",
    "runbook_succeeded",
  ],
  webhook: [...ALERT_EVENT_TYPES],
};

/** What the NOTIFY_* env channels received before channels existed, plus test alerts. */
export const LEGACY_ENV_ALERT_EVENTS: AlertEventType[] = [
  "server_down",
  "server_up",
  "service_down",
  "service_up",
  "access_request",
  "test",
];

export const ALERT_SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

// ─── Filters (Pro) ───────────────────────────────────────────────────────────

export const AlertChannelFilters = z.object({
  serverIds: z.array(z.number().int().positive()).max(1000).optional(),
  tagIds: z.array(z.number().int().positive()).max(200).optional(),
  environments: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  /** Drop trigger/info events below this severity. Resolves always pass so incidents close. */
  minSeverity: AlertSeveritySchema.optional(),
  /** Deliver events that are not about any server/service (system, access requests…). Default true. */
  includeUnscoped: z.boolean().optional(),
});
export type AlertChannelFilters = z.infer<typeof AlertChannelFilters>;

/** True when a filter object actually narrows anything (and so needs the Pro feature). */
export function hasActiveAlertFilters(f: AlertChannelFilters | null | undefined): boolean {
  if (!f) return false;
  return (
    (f.serverIds?.length ?? 0) > 0 ||
    (f.tagIds?.length ?? 0) > 0 ||
    (f.environments?.length ?? 0) > 0 ||
    f.minSeverity !== undefined
  );
}

// ─── Create / update inputs (discriminated on `type`) ────────────────────────

/** Shape check only (this package has no DOM/Node `URL`); the API applies the real SSRF policy. */
const HttpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .regex(/^https?:\/\/[^\s/?#]+[^\s]*$/i, "Must be an http(s) URL");

/** Custom webhook headers: plain token names only; reserved names are rejected by the API. */
export const AlertWebhookHeaders = z
  .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid header name"), z.string().max(1024))
  .refine((h) => Object.keys(h).length <= 10, "At most 10 custom headers");

export const WEBHOOK_FORMATS = ["default", "legacy_v1", "template"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

const ChannelBase = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  events: z.array(AlertEventTypeSchema).min(1).max(ALERT_EVENT_TYPES.length),
  filters: AlertChannelFilters.nullable().optional(),
});

export const SlackChannelConfig = z.object({ mention: z.enum(["none", "here", "channel"]).optional() });
export const TeamsChannelConfig = z.object({});
export const DiscordChannelConfig = z.object({});
export const PagerDutyChannelConfig = z.object({ region: z.enum(["us", "eu"]).optional() });
export const TelegramChannelConfig = z.object({
  chatId: z.string().trim().regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/, "Numeric chat id or @channelname"),
});
export const WebhookChannelConfig = z.object({
  format: z.enum(WEBHOOK_FORMATS).optional(),
  /** JSON document whose string leaves may contain {{event.title}}-style placeholders (Pro). */
  template: z.string().max(16_384).optional(),
});
export const EmailChannelConfig = z.object({
  emails: z.array(z.string().trim().email().max(254)).min(1).max(50),
});

const PagerDutyRoutingKey = z.string().trim().regex(/^[A-Za-z0-9]{32}$/, "PagerDuty integration keys are 32 characters");
const TelegramBotToken = z.string().trim().regex(/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/, "Looks like 123456:ABC-DEF…");
const HmacSecret = z.string().min(16, "Use at least 16 characters").max(256);

export const SlackChannelCreate = ChannelBase.extend({ type: z.literal("slack"), url: HttpUrl, config: SlackChannelConfig.optional() });
export const TeamsChannelCreate = ChannelBase.extend({ type: z.literal("teams"), url: HttpUrl, config: TeamsChannelConfig.optional() });
export const DiscordChannelCreate = ChannelBase.extend({ type: z.literal("discord"), url: HttpUrl, config: DiscordChannelConfig.optional() });
export const PagerDutyChannelCreate = ChannelBase.extend({
  type: z.literal("pagerduty"),
  routingKey: PagerDutyRoutingKey,
  config: PagerDutyChannelConfig.optional(),
});
export const TelegramChannelCreate = ChannelBase.extend({
  type: z.literal("telegram"),
  botToken: TelegramBotToken,
  config: TelegramChannelConfig,
});
export const WebhookChannelCreate = ChannelBase.extend({
  type: z.literal("webhook"),
  url: HttpUrl,
  hmacSecret: HmacSecret.optional(),
  headers: AlertWebhookHeaders.optional(),
  config: WebhookChannelConfig.optional(),
});
export const EmailChannelCreate = ChannelBase.extend({ type: z.literal("email"), config: EmailChannelConfig });

export const AlertChannelCreateInput = z.discriminatedUnion("type", [
  SlackChannelCreate,
  TeamsChannelCreate,
  DiscordChannelCreate,
  PagerDutyChannelCreate,
  TelegramChannelCreate,
  WebhookChannelCreate,
  EmailChannelCreate,
]);
export type AlertChannelCreateInput = z.infer<typeof AlertChannelCreateInput>;

/**
 * PATCH body. `type` must match the stored channel (a channel never changes type).
 * Omitted secret fields keep the stored secret ("leave blank to keep"); for the
 * optional webhook secrets, `null` clears them.
 */
export const AlertChannelUpdateInput = z.discriminatedUnion("type", [
  SlackChannelCreate.partial().extend({ type: z.literal("slack") }),
  TeamsChannelCreate.partial().extend({ type: z.literal("teams") }),
  DiscordChannelCreate.partial().extend({ type: z.literal("discord") }),
  PagerDutyChannelCreate.partial().extend({ type: z.literal("pagerduty") }),
  TelegramChannelCreate.partial().extend({ type: z.literal("telegram") }),
  WebhookChannelCreate.partial().extend({
    type: z.literal("webhook"),
    hmacSecret: HmacSecret.nullable().optional(),
    headers: AlertWebhookHeaders.nullable().optional(),
  }),
  EmailChannelCreate.partial().extend({ type: z.literal("email") }),
]);
export type AlertChannelUpdateInput = z.infer<typeof AlertChannelUpdateInput>;

/** PATCH shortcut used by the enable switch; works for env-managed channels too. */
export const AlertChannelToggleInput = z.object({ enabled: z.boolean() });

// ─── DTOs (never carry secrets) ──────────────────────────────────────────────

export const AlertChannelHealth = z.object({
  status: z.enum(["ok", "failing", "unknown"]),
  consecutiveFailures: z.number().int(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type AlertChannelHealth = z.infer<typeof AlertChannelHealth>;

export const AlertChannelDto = z.object({
  id: z.number().int(),
  name: z.string(),
  type: AlertChannelTypeSchema,
  enabled: z.boolean(),
  managedBy: z.enum(["ui", "env"]),
  envKey: z.string().nullable(),
  /** Non-secret settings only (chat id, recipients, region, format, template…). */
  config: z.record(z.string(), z.unknown()),
  secretHint: z.string().nullable(),
  hasSecret: z.boolean(),
  hasHmacSecret: z.boolean(),
  headerNames: z.array(z.string()),
  events: z.array(AlertEventTypeSchema),
  filters: AlertChannelFilters.nullable(),
  health: AlertChannelHealth,
  /** False when the current license would suppress this channel's deliveries. */
  licensed: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AlertChannelDto = z.infer<typeof AlertChannelDto>;

export const AlertChannelListResponse = z.object({
  items: z.array(AlertChannelDto),
  license: z.object({
    multiChannel: z.boolean(),
    /** null = unlimited */
    uiChannelLimit: z.number().int().nullable(),
    uiChannelCount: z.number().int(),
  }),
  emailConfigured: z.boolean(),
  publicBaseUrl: z.string().nullable(),
});
export type AlertChannelListResponse = z.infer<typeof AlertChannelListResponse>;

export const AlertDeliveryListQuery = z.object({
  status: z.enum(ALERT_DELIVERY_STATUSES).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AlertDeliveryListQuery = z.infer<typeof AlertDeliveryListQuery>;

export const AlertEventSummaryDto = z.object({
  id: z.number().int(),
  type: AlertEventTypeSchema,
  severity: AlertSeveritySchema,
  action: z.enum(["trigger", "resolve", "info"]),
  title: z.string(),
  createdAt: z.string(),
});
export type AlertEventSummaryDto = z.infer<typeof AlertEventSummaryDto>;

export const AlertDeliveryDto = z.object({
  id: z.number().int(),
  eventId: z.number().int(),
  channelId: z.number().int(),
  status: z.enum(ALERT_DELIVERY_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: z.string(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  event: AlertEventSummaryDto,
});
export type AlertDeliveryDto = z.infer<typeof AlertDeliveryDto>;

export const AlertDeliveryListResponse = z.object({
  items: z.array(AlertDeliveryDto),
  nextCursor: z.number().int().nullable(),
});
export type AlertDeliveryListResponse = z.infer<typeof AlertDeliveryListResponse>;

export const AlertEventListQuery = z.object({
  type: AlertEventTypeSchema.optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AlertEventListQuery = z.infer<typeof AlertEventListQuery>;

export const AlertEventDto = AlertEventSummaryDto.extend({
  dedupKey: z.string().nullable(),
  summary: z.string(),
  serverId: z.number().int().nullable(),
  serviceId: z.number().int().nullable(),
  heartbeatId: z.number().int().nullable(),
  runbookRunId: z.number().int().nullable(),
  deliveries: z.array(
    z.object({
      id: z.number().int(),
      channelId: z.number().int(),
      channelName: z.string(),
      channelType: AlertChannelTypeSchema,
      status: z.enum(ALERT_DELIVERY_STATUSES),
      attempts: z.number().int(),
      lastStatusCode: z.number().int().nullable(),
    }),
  ),
});
export type AlertEventDto = z.infer<typeof AlertEventDto>;

export const AlertEventListResponse = z.object({
  items: z.array(AlertEventDto),
  nextCursor: z.number().int().nullable(),
});
export type AlertEventListResponse = z.infer<typeof AlertEventListResponse>;

export const AlertChannelTestResult = z.object({
  ok: z.boolean(),
  statusCode: z.number().int().nullable(),
  /** Sanitized: never contains the channel URL or token. */
  error: z.string().nullable(),
  durationMs: z.number().int(),
  /** Delivery-log row written for a saved channel; null for an unsaved draft. */
  deliveryId: z.number().int().nullable(),
});
export type AlertChannelTestResult = z.infer<typeof AlertChannelTestResult>;

/** A channel as seen from one server's detail page: would this server's alerts reach it? */
export const ServerAlertChannelDto = z.object({
  id: z.number().int(),
  name: z.string(),
  type: AlertChannelTypeSchema,
  enabled: z.boolean(),
  managedBy: z.enum(["ui", "env"]),
  events: z.array(AlertEventTypeSchema),
  /** True when the channel's filters narrow scope and this server passed them. */
  scoped: z.boolean(),
  licensed: z.boolean(),
  health: AlertChannelHealth.shape.status,
});
export type ServerAlertChannelDto = z.infer<typeof ServerAlertChannelDto>;
