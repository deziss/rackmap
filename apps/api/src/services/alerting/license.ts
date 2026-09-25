import {
  ALERT_FREE_UI_CHANNEL_LIMIT,
  ALERT_PRO_CHANNEL_TYPES,
  hasActiveAlertFilters,
  type AlertChannelType,
} from "@inv/shared";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { getLicenseStatus } from "../license.service.js";
import { parseFilters } from "./filters.js";

/**
 * License rules for alert channels.
 *
 * Free: every env-managed channel (NOTIFY_*), per-user email preferences, and
 * ONE UI channel of type slack/discord/telegram/email/webhook with no filters
 * and no custom template. `multi_channel_alerts` (Pro and up) lifts all of it:
 * unlimited channels, Teams, PagerDuty, filters, templates.
 *
 * Writes are refused up front (assertChannelAllowed → 403 NOT_LICENSED). A
 * license that lapses later does not delete anything: dispatch marks the
 * deliveries of channels outside the free allowance `suppressed` with a reason,
 * so the delivery log shows exactly what was not sent and why.
 */

const CACHE_MS = 60_000;
let cache: { at: number; multi: boolean } | null = null;

/** getLicenseStatus costs two queries; the dispatcher asks on every tick, so cache it for 60s. */
export async function isMultiChannelLicensed(now = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < CACHE_MS) return cache.multi;
  const status = await getLicenseStatus();
  cache = { at: now, multi: !!status.features.multi_channel_alerts };
  return cache.multi;
}

/** Drop the cached verdict (tests, and anything that just changed the license). */
export function invalidateAlertLicenseCache(): void {
  cache = null;
}

interface LicensableChannel {
  id?: number;
  type: string;
  managedBy?: string;
  filters?: unknown;
  config?: unknown;
}

/** Why this channel needs `multi_channel_alerts`, or null if the free tier covers it. */
export function proFeatureReason(ch: LicensableChannel): string | null {
  if (ch.managedBy === "env") return null;
  if ((ALERT_PRO_CHANNEL_TYPES as readonly string[]).includes(ch.type)) {
    return `${ch.type === "pagerduty" ? "PagerDuty" : "Microsoft Teams"} channels`;
  }
  if (hasActiveAlertFilters(parseFilters(ch.filters))) return "Channel filters";
  const config = (ch.config ?? {}) as Record<string, unknown>;
  if (ch.type === "webhook" && config.format === "template") return "Custom webhook templates";
  return null;
}

export interface LicensedChannels {
  /** Everything is licensed (multi_channel_alerts). */
  all: boolean;
  ids: Set<number>;
}

/**
 * Which channels may deliver right now. On the free tier: all env channels,
 * plus the oldest enabled UI channel that the free tier covers.
 */
export async function getLicensedChannelIds(): Promise<LicensedChannels> {
  if (await isMultiChannelLicensed()) return { all: true, ids: new Set() };
  const channels = await prisma.alertChannel.findMany({
    where: { enabled: true },
    select: { id: true, type: true, managedBy: true, filters: true, config: true },
    orderBy: { id: "asc" },
  });
  const ids = new Set<number>();
  let uiUsed = 0;
  for (const ch of channels) {
    if (ch.managedBy === "env") {
      ids.add(ch.id);
    } else if (uiUsed < ALERT_FREE_UI_CHANNEL_LIMIT && !proFeatureReason(ch)) {
      ids.add(ch.id);
      uiUsed += 1;
    }
  }
  return { all: false, ids };
}

export function isLicensed(set: LicensedChannels, channelId: number): boolean {
  return set.all || set.ids.has(channelId);
}

export const UNLICENSED_REASON =
  "Not licensed: this channel is outside the free tier (one UI channel, no Teams/PagerDuty, no filters or templates)";

/**
 * Refuse a create/update/enable the current license does not cover. Always
 * reads the license fresh — this is a write path, not the dispatcher hot loop.
 */
export async function assertChannelAllowed(
  ch: { type: AlertChannelType; filters?: unknown; config?: unknown; managedBy?: string },
  opts: { excludeId?: number } = {},
): Promise<void> {
  if (ch.managedBy === "env") return;
  const status = await getLicenseStatus();
  if (status.features.multi_channel_alerts) return;

  const reason = proFeatureReason(ch);
  if (reason) {
    throw new AppError(
      "NOT_LICENSED",
      `${reason} require RackMap Pro (Multi-Channel Alert Dispatching). Upgrade in Settings → Subscription.`,
      403,
    );
  }
  const others = await prisma.alertChannel.count({
    where: { managedBy: "ui", ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}) },
  });
  if (others >= ALERT_FREE_UI_CHANNEL_LIMIT) {
    throw new AppError(
      "NOT_LICENSED",
      `The free tier includes ${ALERT_FREE_UI_CHANNEL_LIMIT} alert channel (plus NOTIFY_* env channels). Upgrade to RackMap Pro for unlimited channels.`,
      403,
    );
  }
}
