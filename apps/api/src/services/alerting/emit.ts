import { prisma } from "../../db.js";
import type { AlertEventType, AlertSeverity } from "@inv/shared";
import { hasScopeFilters, matchesFilters, parseFilters, resolveEventScope, type EventScope } from "./filters.js";
import { getLicensedChannelIds, isLicensed, UNLICENSED_REASON } from "./license.js";
import { kickDispatcher } from "./dispatcher.js";

/**
 * The single entry point for raising an alert. Every feature (status flips,
 * metrics, SSL, heartbeats, runbooks, access requests) calls emitAlert() and
 * nothing else; the channels are this module's problem.
 *
 * Outbox pattern: the event row is written first, then one AlertDelivery row
 * per channel that should get it. The dispatcher sends those rows in the
 * background — any replica can claim any row — with retries, backoff and a
 * delivery log. A crash between here and the send loses nothing: the rows are
 * already in the database.
 *
 * Channels that match but are outside the current license still get a
 * delivery row, created `suppressed` with the reason, so "why did Slack not
 * get this?" is answered by the delivery log rather than by silence.
 *
 * Per-user email preferences are NOT a channel: notify.service.ts sends those
 * directly, as it always has.
 */
export interface AlertEventInput {
  type: AlertEventType;
  severity: AlertSeverity;
  /** "trigger" opens an incident, "resolve" closes the one with the same dedupKey. */
  action?: "trigger" | "resolve" | "info";
  /** Stable incident key, e.g. `rackmap:server:12`, `rackmap:heartbeat:3`, `rackmap:runbook:7`. */
  dedupKey?: string;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  serverId?: number | null;
  serviceId?: number | null;
  heartbeatId?: number | null;
  runbookRunId?: number | null;
  /** Used for channel filters when a serverId is not enough. */
  tagIds?: number[];
  environment?: string | null;
}

/** Postgres text columns reject NUL; titles/summaries come from hosts and job output. */
function clean(s: string, max: number): string {
  const t = s.replace(/\u0000/g, "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Deep copy with NUL removed from every string (jsonb rejects \u0000 too); drops undefined like JSON. */
function stripNul(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\u0000/g, "");
  if (Array.isArray(v)) return v.map(stripNul);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = stripNul(val);
    return out;
  }
  return v;
}

export async function emitAlert(e: AlertEventInput): Promise<{ eventId: number; queued: number }> {
  const event = await prisma.alertEvent.create({
    data: {
      type: e.type,
      severity: e.severity,
      action: e.action ?? "info",
      dedupKey: e.dedupKey ?? null,
      title: clean(e.title, 500),
      summary: clean(e.summary, 4000),
      payload: stripNul(e.payload ?? {}) as object,
      serverId: e.serverId ?? null,
      serviceId: e.serviceId ?? null,
      heartbeatId: e.heartbeatId ?? null,
      runbookRunId: e.runbookRunId ?? null,
    },
  });

  let queued = 0;
  try {
    const channels = await prisma.alertChannel.findMany({
      where: { enabled: true, events: { has: e.type } },
      select: { id: true, filters: true },
      orderBy: { id: "asc" },
    });
    if (channels.length === 0) return { eventId: event.id, queued: 0 };

    const parsed = channels.map((c) => ({ id: c.id, filters: parseFilters(c.filters) }));
    // Only look the server up when some channel actually filters on scope.
    let scope: EventScope = {
      serverId: e.serverId ?? null,
      tagIds: e.tagIds ?? [],
      environment: e.environment ?? null,
      scoped: !!(e.serverId || e.serviceId || e.tagIds?.length || e.environment),
    };
    if (parsed.some((c) => hasScopeFilters(c.filters))) scope = await resolveEventScope(e);

    const licensed = await getLicensedChannelIds();
    const action = e.action ?? "info";
    const rows = parsed
      .filter((c) => matchesFilters(c.filters, { severity: e.severity, action }, scope))
      .map((c) =>
        isLicensed(licensed, c.id)
          ? { eventId: event.id, channelId: c.id, status: "pending" }
          : { eventId: event.id, channelId: c.id, status: "suppressed", lastError: UNLICENSED_REASON },
      );
    if (rows.length > 0) {
      await prisma.alertDelivery.createMany({ data: rows });
      queued = rows.filter((r) => r.status === "pending").length;
    }
  } catch (err) {
    // The event itself is recorded; a fan-out failure must not break the caller
    // (a status flip, a heartbeat ping). Log without payload — it can be large.
    console.error(`[alerts] fan-out failed for event ${event.id}:`, (err as Error).message);
  }

  if (queued > 0) kickDispatcher();
  return { eventId: event.id, queued };
}
