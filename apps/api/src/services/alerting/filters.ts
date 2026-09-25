import {
  ALERT_SEVERITY_RANK,
  AlertChannelFilters,
  hasActiveAlertFilters,
  type AlertSeverity,
} from "@inv/shared";
import { prisma } from "../../db.js";

/**
 * Per-channel routing filters (Pro): serverIds / tagIds / environments /
 * minSeverity / includeUnscoped.
 *
 * Semantics:
 *  - Scope dimensions combine with AND (like runbook target selectors); values
 *    within one dimension combine with OR. `environments:[production]` plus
 *    `tagIds:[db]` means "production database hosts".
 *  - An event about no server/service ("unscoped": access requests, system
 *    notices) passes the scope filters only when includeUnscoped (default true).
 *  - minSeverity drops trigger/info events below it, but a RESOLVE always
 *    passes: resolves are sent at "info", and dropping them would leave every
 *    PagerDuty incident the trigger opened hanging forever.
 */

export interface EventScope {
  serverId: number | null;
  tagIds: number[];
  environment: string | null;
  /** The event is about some server or service. */
  scoped: boolean;
}

export interface FilterableEvent {
  severity: AlertSeverity;
  action: "trigger" | "resolve" | "info";
}

export function parseFilters(raw: unknown): AlertChannelFilters | null {
  if (raw === null || raw === undefined) return null;
  const parsed = AlertChannelFilters.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** True when the filter narrows by server/tag/environment (not just severity). */
export function hasScopeFilters(f: AlertChannelFilters | null): boolean {
  return !!f && ((f.serverIds?.length ?? 0) > 0 || (f.tagIds?.length ?? 0) > 0 || (f.environments?.length ?? 0) > 0);
}

export function matchesFilters(filters: AlertChannelFilters | null, event: FilterableEvent, scope: EventScope): boolean {
  if (!filters || !hasActiveAlertFilters(filters)) return true;

  if (filters.minSeverity && event.action !== "resolve") {
    if (ALERT_SEVERITY_RANK[event.severity] < ALERT_SEVERITY_RANK[filters.minSeverity]) return false;
  }

  if (!hasScopeFilters(filters)) return true;
  if (!scope.scoped) return filters.includeUnscoped ?? true;

  if (filters.serverIds?.length) {
    if (scope.serverId === null || !filters.serverIds.includes(scope.serverId)) return false;
  }
  if (filters.tagIds?.length) {
    if (!scope.tagIds.some((t) => filters.tagIds!.includes(t))) return false;
  }
  if (filters.environments?.length) {
    const envs = filters.environments.map((e) => e.toLowerCase());
    if (!scope.environment || !envs.includes(scope.environment.toLowerCase())) return false;
  }
  return true;
}

/**
 * Where an event "is" for filtering. Looks the server (or service) up for its
 * tags and environment, merged with anything the emitter supplied directly.
 */
export async function resolveEventScope(e: {
  serverId?: number | null;
  serviceId?: number | null;
  tagIds?: number[];
  environment?: string | null;
}): Promise<EventScope> {
  const tagIds = new Set<number>(e.tagIds ?? []);
  let environment = e.environment ?? null;
  if (e.serverId) {
    const s = await prisma.server.findUnique({
      where: { id: e.serverId },
      select: { environment: true, tags: { select: { tagId: true } } },
    });
    if (s) {
      environment ??= s.environment;
      for (const t of s.tags) tagIds.add(t.tagId);
    }
  } else if (e.serviceId) {
    const s = await prisma.service.findUnique({
      where: { id: e.serviceId },
      select: { environment: true, tags: { select: { tagId: true } } },
    });
    if (s) {
      environment ??= s.environment;
      for (const t of s.tags) tagIds.add(t.tagId);
    }
  }
  return {
    serverId: e.serverId ?? null,
    tagIds: [...tagIds],
    environment,
    scoped: !!(e.serverId || e.serviceId || tagIds.size > 0 || environment),
  };
}
