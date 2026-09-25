import { Prisma, type AlertChannel } from "@prisma/client";
import {
  ALERT_FREE_UI_CHANNEL_LIMIT,
  LEGACY_ENV_ALERT_EVENTS,
  type AlertChannelCreateInput,
  type AlertChannelDto,
  type AlertChannelHealth,
  type AlertChannelListResponse,
  type AlertChannelTestResult,
  type AlertChannelType,
  type AlertChannelUpdateInput,
  type AlertDeliveryDto,
  type AlertDeliveryListQuery,
  type AlertDeliveryListResponse,
  type AlertEventDto,
  type AlertEventListQuery,
  type AlertEventListResponse,
  type AlertEventType,
  type ServerAlertChannelDto,
} from "@inv/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { AppError, conflict, notFound } from "../lib/errors.js";
import {
  assertAllowedOutboundUrl,
  checkOutboundUrl,
  getOutboundPolicy,
  OutboundBlockedError,
  OutboundNetworkError,
  type OutboundRule,
} from "../lib/outbound-http.js";
import { openChannelSecret, sealChannelSecret, secretHintFor } from "./alerting/channel-secret.js";
import { hasScopeFilters, matchesFilters, parseFilters, resolveEventScope } from "./alerting/filters.js";
import { formatterFor } from "./alerting/formatters/index.js";
import { parseWebhookTemplate } from "./alerting/formatters/webhook.js";
import {
  assertChannelAllowed,
  getLicensedChannelIds,
  isLicensed,
  isMultiChannelLicensed,
  proFeatureReason,
  type LicensedChannels,
} from "./alerting/license.js";
import { policyForChannel, publicBaseUrl, sendFormatted, toFormatChannel, type SendOutcome } from "./alerting/send.js";
import { recordChannelHealth } from "./alerting/dispatcher.js";
import { isEmailConfigured } from "./email.service.js";
import type { ChannelSecret, FormatChannel, FormatEvent } from "./alerting/types.js";

/**
 * Alert channel CRUD, env mirroring and synchronous test sends.
 *
 * Secrets are write-only: inputs carry them, rows store them v3-encrypted in
 * `secretEnc`, and every DTO leaving this module carries only `secretHint`.
 * Omitting a secret on update keeps the stored one.
 */

const URL_TYPES: readonly AlertChannelType[] = ["slack", "teams", "discord", "webhook"];
/** Types that cannot work without a stored secret. */
const SECRET_TYPES: readonly AlertChannelType[] = [...URL_TYPES, "pagerduty", "telegram"];

/** Webhook header names an admin may not set: transport-level, or ours to sign. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "user-agent",
  "expect",
  "upgrade",
]);

function dateStr(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function channelHealth(row: Pick<AlertChannel, "consecutiveFailures" | "lastSuccessAt" | "lastFailureAt" | "lastError">): AlertChannelHealth {
  const failing = row.consecutiveFailures >= 3 || (row.consecutiveFailures >= 1 && !row.lastSuccessAt);
  return {
    status: failing ? "failing" : row.lastSuccessAt ? "ok" : "unknown",
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: dateStr(row.lastSuccessAt),
    lastFailureAt: dateStr(row.lastFailureAt),
    lastError: row.lastError,
  };
}

/**
 * Display flag: would this channel's deliveries go out? A disabled channel is
 * judged on whether the license covers what it IS (type, filters, template),
 * not on the free tier's one-enabled-channel slot it does not occupy.
 */
function licensedForDisplay(row: AlertChannel, licensed: LicensedChannels): boolean {
  return isLicensed(licensed, row.id) || (!row.enabled && !proFeatureReason(row));
}

export function toChannelDto(row: AlertChannel, licensed: LicensedChannels): AlertChannelDto {
  const opened = openChannelSecret(row.secretEnc);
  const secret = opened.ok ? opened.secret : {};
  return {
    id: row.id,
    name: row.name,
    type: row.type as AlertChannelType,
    enabled: row.enabled,
    managedBy: row.managedBy === "env" ? "env" : "ui",
    envKey: row.envKey,
    config: asRecord(row.config),
    secretHint: row.secretHint,
    hasSecret: !!row.secretEnc,
    hasHmacSecret: !!secret.hmacSecret,
    headerNames: Object.keys(secret.headers ?? {}),
    events: row.events as AlertEventType[],
    filters: parseFilters(row.filters),
    health: channelHealth(row),
    licensed: licensedForDisplay(row, licensed),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function badRequest(message: string) {
  return new AppError("VALIDATION_ERROR", message, 400);
}

// ─── Validation ──────────────────────────────────────────────────────────────

interface Normalized {
  secret: ChannelSecret;
  config: Record<string, unknown>;
}

/** Split an input into (secret, non-secret config). Only keys present in the input. */
function splitInput(input: Partial<AlertChannelCreateInput> & { type: AlertChannelType }): {
  secret: Partial<Record<keyof ChannelSecret, unknown>>;
  config: Record<string, unknown> | undefined;
} {
  const i = input as Record<string, unknown>;
  const secret: Partial<Record<keyof ChannelSecret, unknown>> = {};
  for (const k of ["url", "routingKey", "botToken", "hmacSecret", "headers"] as const) {
    if (k in i && i[k] !== undefined) secret[k] = i[k];
  }
  return { secret, config: i.config === undefined ? undefined : asRecord(i.config) };
}

/** Throws 400 with a user-facing message when the channel cannot work as configured. */
async function validateChannel(type: AlertChannelType, n: Normalized, managedBy: string): Promise<void> {
  const policy = policyForChannel({ managedBy }, getOutboundPolicy());
  if (URL_TYPES.includes(type)) {
    if (!n.secret.url) throw badRequest("A webhook URL is required");
    try {
      const checked = checkOutboundUrl(n.secret.url, type as OutboundRule, policy);
      // Fixed-host types are checked again, with DNS, at every send. Generic and
      // allowlisted hosts are resolved now too, so "points at 10.x" fails at save.
      if (type === "webhook" || checked.allowlisted) await assertAllowedOutboundUrl(n.secret.url, type as OutboundRule, policy);
    } catch (err) {
      if (err instanceof OutboundBlockedError) throw badRequest(err.message);
      if (err instanceof OutboundNetworkError) throw badRequest(`Could not resolve the webhook host: ${err.message}`);
      throw err;
    }
  }
  if (type === "pagerduty" && !n.secret.routingKey) throw badRequest("A PagerDuty routing key is required");
  if (type === "telegram") {
    if (!n.secret.botToken) throw badRequest("A Telegram bot token is required");
    if (typeof n.config.chatId !== "string" || !n.config.chatId) throw badRequest("A Telegram chat id is required");
  }
  if (type === "email") {
    const emails = n.config.emails;
    if (!Array.isArray(emails) || emails.length === 0) throw badRequest("At least one recipient email is required");
  }
  if (type === "webhook") {
    for (const name of Object.keys(n.secret.headers ?? {})) {
      const lower = name.toLowerCase();
      if (RESERVED_HEADERS.has(lower) || lower.startsWith("x-rackmap-")) {
        throw badRequest(`Header "${name}" is reserved and cannot be set`);
      }
    }
    if (n.config.format === "template") {
      if (typeof n.config.template !== "string" || !n.config.template.trim()) {
        throw badRequest("A template is required when the format is \"template\"");
      }
      try {
        parseWebhookTemplate(n.config.template);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }
  }
}

function normalizeConfig(type: AlertChannelType, config: Record<string, unknown>): Record<string, unknown> {
  if (type === "email" && Array.isArray(config.emails)) {
    return { ...config, emails: [...new Set((config.emails as string[]).map((e) => e.trim().toLowerCase()))] };
  }
  return config;
}

/** Filters column value: the parsed object, or SQL NULL for "no filters". */
function filtersJson(f: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const parsed = parseFilters(f);
  return parsed ? (parsed as Prisma.InputJsonValue) : Prisma.DbNull;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listChannels(): Promise<AlertChannelListResponse> {
  const [rows, licensed, multi] = await Promise.all([
    prisma.alertChannel.findMany({ orderBy: [{ managedBy: "asc" }, { id: "asc" }] }),
    getLicensedChannelIds(),
    isMultiChannelLicensed(),
  ]);
  return {
    items: rows.map((r) => toChannelDto(r, licensed)),
    license: {
      multiChannel: multi,
      uiChannelLimit: multi ? null : ALERT_FREE_UI_CHANNEL_LIMIT,
      uiChannelCount: rows.filter((r) => r.managedBy !== "env").length,
    },
    emailConfigured: isEmailConfigured(),
    publicBaseUrl: publicBaseUrl(),
  };
}

async function loadChannel(id: number): Promise<AlertChannel> {
  const row = await prisma.alertChannel.findUnique({ where: { id } });
  if (!row) throw notFound("Alert channel");
  return row;
}

export async function getChannel(id: number): Promise<AlertChannelDto> {
  const [row, licensed] = await Promise.all([loadChannel(id), getLicensedChannelIds()]);
  return toChannelDto(row, licensed);
}

export async function createChannel(input: AlertChannelCreateInput, actorId: string | null): Promise<AlertChannelDto> {
  const { secret, config } = splitInput(input);
  const n: Normalized = {
    secret: secret as ChannelSecret,
    config: normalizeConfig(input.type, config ?? {}),
  };
  await assertChannelAllowed({ type: input.type, filters: input.filters, config: n.config });
  await validateChannel(input.type, n, "ui");

  const row = await prisma.alertChannel.create({
    data: {
      name: input.name,
      type: input.type,
      enabled: input.enabled ?? true,
      managedBy: "ui",
      config: n.config as Prisma.InputJsonValue,
      secretEnc: sealChannelSecret(n.secret),
      secretHint: secretHintFor(input.type, n.secret),
      events: [...new Set(input.events)],
      filters: filtersJson(input.filters),
      createdById: actorId,
    },
  });
  return toChannelDto(row, await getLicensedChannelIds());
}

/** Fields an env-managed channel accepts; everything else comes from NOTIFY_* and is re-synced at boot. */
const ENV_EDITABLE = new Set(["type", "name", "enabled", "events"]);

export async function updateChannel(
  id: number,
  input: AlertChannelUpdateInput | { enabled: boolean },
): Promise<{ before: AlertChannelDto; after: AlertChannelDto }> {
  const existing = await loadChannel(id);
  const licensedBefore = await getLicensedChannelIds();
  const before = toChannelDto(existing, licensedBefore);
  const i = input as Record<string, unknown>;
  const type = (typeof i.type === "string" ? i.type : existing.type) as AlertChannelType;
  if (type !== existing.type) throw badRequest("A channel's type cannot be changed; create a new channel instead");

  if (existing.managedBy === "env") {
    const extra = Object.keys(i).filter((k) => i[k] !== undefined && !ENV_EDITABLE.has(k));
    if (extra.length > 0) {
      throw conflict(`This channel is managed by ${existing.envKey ?? "environment variables"}; only name, events and enabled can be changed here`);
    }
  }

  const { secret: provided, config } = splitInput({ ...(input as object), type } as Parameters<typeof splitInput>[0]);
  const opened = openChannelSecret(existing.secretEnc);
  const nextEnabled = typeof i.enabled === "boolean" ? i.enabled : existing.enabled;
  if (!opened.ok && nextEnabled && Object.keys(provided).length === 0 && SECRET_TYPES.includes(type)) {
    // The stored secret is unreadable; keeping it enabled would keep a broken channel.
    throw badRequest(opened.reason);
  }
  const secret: ChannelSecret = { ...(opened.ok ? opened.secret : {}) };
  for (const [k, v] of Object.entries(provided)) {
    if (v === null || v === "") delete secret[k as keyof ChannelSecret];
    else (secret as Record<string, unknown>)[k] = v;
  }
  const nextConfig = normalizeConfig(type, config ?? asRecord(existing.config));
  const nextFilters = "filters" in i ? i.filters : existing.filters;

  if (nextEnabled) {
    await assertChannelAllowed(
      { type, filters: nextFilters, config: nextConfig, managedBy: existing.managedBy },
      { excludeId: id },
    );
  }
  const secretChanged = Object.keys(provided).length > 0;
  if (secretChanged || config !== undefined) await validateChannel(type, { secret, config: nextConfig }, existing.managedBy);

  const row = await prisma.alertChannel.update({
    where: { id },
    data: {
      ...(typeof i.name === "string" ? { name: i.name } : {}),
      enabled: nextEnabled,
      ...(Array.isArray(i.events) ? { events: [...new Set(i.events as string[])] } : {}),
      ...("filters" in i ? { filters: filtersJson(i.filters) } : {}),
      ...(config !== undefined ? { config: nextConfig as Prisma.InputJsonValue } : {}),
      ...(secretChanged ? { secretEnc: sealChannelSecret(secret), secretHint: secretHintFor(type, secret) } : {}),
    },
  });
  return { before, after: toChannelDto(row, await getLicensedChannelIds()) };
}

export async function deleteChannel(id: number): Promise<AlertChannelDto> {
  const existing = await loadChannel(id);
  if (existing.managedBy === "env") {
    throw conflict(`This channel is managed by ${existing.envKey ?? "environment variables"}; unset the variable and restart to remove it`);
  }
  const dto = toChannelDto(existing, await getLicensedChannelIds());
  await prisma.alertChannel.delete({ where: { id } });
  return dto;
}

// ─── Delivery / event logs ───────────────────────────────────────────────────

export async function listDeliveries(channelId: number, q: AlertDeliveryListQuery): Promise<AlertDeliveryListResponse> {
  await loadChannel(channelId);
  const rows = await prisma.alertDelivery.findMany({
    where: { channelId, ...(q.status ? { status: q.status } : {}), ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
    include: { event: { select: { id: true, type: true, severity: true, action: true, title: true, createdAt: true } } },
    orderBy: { id: "desc" },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return {
    items: page.map(
      (d): AlertDeliveryDto => ({
        id: d.id,
        eventId: d.eventId,
        channelId: d.channelId,
        status: d.status as AlertDeliveryDto["status"],
        attempts: d.attempts,
        maxAttempts: d.maxAttempts,
        nextAttemptAt: d.nextAttemptAt.toISOString(),
        lastStatusCode: d.lastStatusCode,
        lastError: d.lastError,
        sentAt: dateStr(d.sentAt),
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
        event: {
          id: d.event.id,
          type: d.event.type as AlertEventType,
          severity: d.event.severity as AlertDeliveryDto["event"]["severity"],
          action: d.event.action as AlertDeliveryDto["event"]["action"],
          title: d.event.title,
          createdAt: d.event.createdAt.toISOString(),
        },
      }),
    ),
    nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function listEvents(q: AlertEventListQuery): Promise<AlertEventListResponse> {
  const rows = await prisma.alertEvent.findMany({
    where: { ...(q.type ? { type: q.type } : {}), ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
    include: {
      deliveries: {
        select: { id: true, channelId: true, status: true, attempts: true, lastStatusCode: true, channel: { select: { name: true, type: true } } },
        orderBy: { id: "asc" },
      },
    },
    orderBy: { id: "desc" },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return {
    items: page.map(
      (e): AlertEventDto => ({
        id: e.id,
        type: e.type as AlertEventType,
        severity: e.severity as AlertEventDto["severity"],
        action: e.action as AlertEventDto["action"],
        title: e.title,
        summary: e.summary,
        dedupKey: e.dedupKey,
        serverId: e.serverId,
        serviceId: e.serviceId,
        heartbeatId: e.heartbeatId,
        runbookRunId: e.runbookRunId,
        createdAt: e.createdAt.toISOString(),
        deliveries: e.deliveries.map((d) => ({
          id: d.id,
          channelId: d.channelId,
          channelName: d.channel.name,
          channelType: d.channel.type as AlertChannelType,
          status: d.status as AlertEventDto["deliveries"][number]["status"],
          attempts: d.attempts,
          lastStatusCode: d.lastStatusCode,
        })),
      }),
    ),
    nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// ─── Per-server view ─────────────────────────────────────────────────────────

/** Event types that can be about a server — what the server card cares about. */
const SERVER_EVENT_TYPES: readonly string[] = [
  "server_down",
  "server_up",
  "metric_alert",
  "ssl_expiring",
  "heartbeat_late",
  "heartbeat_fail",
  "heartbeat_recover",
  "runbook_failed",
  "runbook_succeeded",
  "test",
];

/** Channels this server's alerts would reach (filters evaluated against its tags/environment). */
export async function channelsForServer(serverId: number): Promise<ServerAlertChannelDto[]> {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server) throw notFound("Server");
  const [rows, licensed, scope] = await Promise.all([
    prisma.alertChannel.findMany({ orderBy: { id: "asc" } }),
    getLicensedChannelIds(),
    resolveEventScope({ serverId }),
  ]);
  return rows
    .filter((r) => r.events.some((e) => SERVER_EVENT_TYPES.includes(e)))
    .filter((r) => matchesFilters(parseFilters(r.filters), { severity: "critical", action: "trigger" }, scope))
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type as AlertChannelType,
      enabled: r.enabled,
      managedBy: r.managedBy === "env" ? ("env" as const) : ("ui" as const),
      events: r.events as AlertEventType[],
      scoped: hasScopeFilters(parseFilters(r.filters)),
      licensed: licensedForDisplay(r, licensed),
      health: channelHealth(r).status,
    }));
}

// ─── Test sends ──────────────────────────────────────────────────────────────

function testEvent(channelName: string, type: AlertChannelType, id: number, now: Date): FormatEvent {
  return {
    id,
    type: "test",
    severity: "info",
    // PagerDuty needs a trigger (then an immediate resolve) to prove the key works.
    action: type === "pagerduty" ? "trigger" : "info",
    dedupKey: type === "pagerduty" ? `rackmap:test:${id}:${now.getTime()}` : null,
    title: "RackMap test alert",
    summary: `Test message for the "${channelName}" alert channel. If you can read this, RackMap alerts will reach it.`,
    payload: { test: true },
    serverId: null,
    serviceId: null,
    heartbeatId: null,
    runbookRunId: null,
    createdAt: now,
  };
}

async function sendTest(channel: FormatChannel, managedBy: string, secret: ChannelSecret, event: FormatEvent, deliveryId: string): Promise<SendOutcome> {
  const formatter = formatterFor(channel.type);
  if (!formatter) return { ok: false, retryable: false, statusCode: null, error: "Unknown channel type" };
  const policy = policyForChannel({ managedBy });
  const ctx = { deliveryId, now: new Date(), baseUrl: publicBaseUrl() };
  const req = formatter.format(event, channel, secret, ctx);
  if (req.kind === "skip") return { ok: false, retryable: false, statusCode: null, error: req.reason };
  const out = await sendFormatted(req, formatter, policy);
  if (!out.ok || channel.type !== "pagerduty" || !event.dedupKey) return out;
  // Close the test incident straight away so nobody is left holding a page.
  const resolve = formatter.format({ ...event, action: "resolve" }, channel, secret, ctx);
  if (resolve.kind === "skip") return out;
  const res2 = await sendFormatted(resolve, formatter, policy);
  return res2.ok ? out : { ...res2, error: `Trigger sent but the resolve failed: ${res2.error ?? "unknown error"}` };
}

/**
 * Send one test message now and report the result. For a saved channel this
 * writes a `test` event plus a delivery-log row; a draft (unsaved form) leaves
 * no trace. Never retried — the operator is looking at the result.
 */
export async function testChannel(target: number | AlertChannelCreateInput): Promise<AlertChannelTestResult> {
  const started = Date.now();

  if (typeof target !== "number") {
    const { secret, config } = splitInput(target);
    const n: Normalized = { secret: secret as ChannelSecret, config: normalizeConfig(target.type, config ?? {}) };
    if (!(await isMultiChannelLicensed())) {
      const reason = proFeatureReason({ type: target.type, filters: target.filters, config: n.config });
      if (reason) throw new AppError("NOT_LICENSED", `${reason} require RackMap Pro (Multi-Channel Alert Dispatching).`, 403);
    }
    await validateChannel(target.type, n, "ui");
    const channel: FormatChannel = { id: 0, name: target.name, type: target.type, config: n.config };
    const out = await sendTest(channel, "ui", n.secret, testEvent(target.name, target.type, 0, new Date()), `test-${started}`);
    return { ok: out.ok, statusCode: out.statusCode, error: out.error, durationMs: Date.now() - started, deliveryId: null };
  }

  const row = await loadChannel(target);
  // Test sends are rate-limited and synchronous; on the free tier any channel the
  // free tier could cover may be tested (including a disabled one), Pro types not.
  if (!(await isMultiChannelLicensed())) {
    const reason = proFeatureReason(row);
    if (reason) throw new AppError("NOT_LICENSED", `${reason} require RackMap Pro (Multi-Channel Alert Dispatching).`, 403);
  }
  const opened = openChannelSecret(row.secretEnc);
  if (!opened.ok) throw badRequest(opened.reason);

  const now = new Date();
  const ev = testEvent(row.name, row.type as AlertChannelType, row.id, now);
  const eventRow = await prisma.alertEvent.create({
    data: {
      type: "test",
      severity: ev.severity,
      action: ev.action,
      dedupKey: ev.dedupKey,
      title: ev.title,
      summary: ev.summary,
      payload: { test: true, channelId: row.id },
    },
  });
  const delivery = await prisma.alertDelivery.create({
    data: { eventId: eventRow.id, channelId: row.id, status: "sending", lockedBy: "test", maxAttempts: 1, lockedUntil: new Date(now.getTime() + 60_000) },
  });
  const out = await sendTest(toFormatChannel(row), row.managedBy, opened.secret, { ...ev, id: eventRow.id }, String(delivery.id));
  await prisma.alertDelivery.update({
    where: { id: delivery.id },
    data: {
      status: out.ok ? "succeeded" : "failed",
      attempts: 1,
      lockedBy: null,
      lockedUntil: null,
      lastStatusCode: out.statusCode,
      lastError: out.error,
      sentAt: out.ok ? new Date() : null,
    },
  });
  await recordChannelHealth(row.id, out.ok, out.error);
  return { ok: out.ok, statusCode: out.statusCode, error: out.error, durationMs: Date.now() - started, deliveryId: delivery.id };
}

// ─── NOTIFY_* env mirroring ──────────────────────────────────────────────────

export interface EnvChannelSource {
  NOTIFY_WEBHOOK_URL?: string;
  NOTIFY_TELEGRAM_BOT_TOKEN?: string;
  NOTIFY_TELEGRAM_CHAT_ID?: string;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

async function upsertEnvChannel(
  envKey: string,
  def: { name: string; type: AlertChannelType; config: Record<string, unknown>; secret: ChannelSecret },
): Promise<"created" | "updated" | "unchanged"> {
  const existing = await prisma.alertChannel.findUnique({ where: { envKey } });
  const hint = secretHintFor(def.type, def.secret);
  if (!existing) {
    await prisma.alertChannel.create({
      data: {
        name: def.name,
        type: def.type,
        managedBy: "env",
        envKey,
        config: def.config as Prisma.InputJsonValue,
        secretEnc: sealChannelSecret(def.secret),
        secretHint: hint,
        events: LEGACY_ENV_ALERT_EVENTS,
      },
    });
    return "created";
  }
  const opened = openChannelSecret(existing.secretEnc);
  const mergedConfig = { ...asRecord(existing.config), ...def.config };
  const same =
    existing.type === def.type &&
    existing.managedBy === "env" &&
    opened.ok &&
    stableJson(opened.secret) === stableJson(def.secret) &&
    stableJson(asRecord(existing.config)) === stableJson(mergedConfig);
  if (same) return "unchanged";
  // Name, events and enabled are the admin's to change and survive a re-sync.
  await prisma.alertChannel.update({
    where: { id: existing.id },
    data: {
      type: def.type,
      managedBy: "env",
      config: mergedConfig as Prisma.InputJsonValue,
      secretEnc: sealChannelSecret(def.secret),
      secretHint: hint,
    },
  });
  return "updated";
}

/**
 * Mirror NOTIFY_* env configuration into managedBy="env" channels, idempotently
 * (called at every boot). NOTIFY_WEBHOOK_URL becomes a `legacy_v1` webhook so
 * the receiver keeps getting the exact bodies it got before; the Telegram pair
 * becomes a telegram channel. Unsetting the variable deletes the channel.
 */
export async function syncEnvAlertChannels(source: EnvChannelSource = env): Promise<void> {
  const webhookUrl = source.NOTIFY_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    try {
      checkOutboundUrl(webhookUrl, "webhook", policyForChannel({ managedBy: "env" }));
    } catch (err) {
      // Mirror it anyway: every delivery attempt will then record why it was refused.
      console.warn(`[alerts] NOTIFY_WEBHOOK_URL will be refused at send time: ${(err as Error).message}`);
    }
    await upsertEnvChannel("NOTIFY_WEBHOOK_URL", {
      name: "Webhook (NOTIFY_WEBHOOK_URL)",
      type: "webhook",
      config: { format: "legacy_v1" },
      secret: { url: webhookUrl },
    });
  } else {
    await prisma.alertChannel.deleteMany({ where: { envKey: "NOTIFY_WEBHOOK_URL" } });
  }

  const botToken = source.NOTIFY_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = source.NOTIFY_TELEGRAM_CHAT_ID?.trim();
  if (botToken && chatId) {
    await upsertEnvChannel("NOTIFY_TELEGRAM", {
      name: "Telegram (NOTIFY_TELEGRAM_*)",
      type: "telegram",
      config: { chatId },
      secret: { botToken },
    });
  } else {
    await prisma.alertChannel.deleteMany({ where: { envKey: "NOTIFY_TELEGRAM" } });
  }
}
