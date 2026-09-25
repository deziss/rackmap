import { Hono } from "hono";
import { ALERT_DELIVERY_STATUSES, HEARTBEAT_STATUSES, RUNBOOK_RUN_STATUSES } from "@inv/shared";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";

/**
 * Prometheus exposition endpoint.
 *
 * RackMap deliberately does not persist a time series of its own: live CPU,
 * memory, disk and GPU readings are collected over SSH on demand and discarded.
 * Building a TSDB inside the application database would be the wrong tool. Exposing the current
 * state here instead lets Prometheus do the storing, Grafana the graphing and
 * Alertmanager the alerting — all of which already exist in most fleets.
 *
 * Mounted under /api/v1 so it inherits API-key authentication. Scrape it with:
 *
 *   scrape_configs:
 *     - job_name: rackmap
 *       metrics_path: /api/v1/metrics
 *       authorization:
 *         type: Bearer
 *         credentials_file: /etc/prometheus/rackmap.key
 *       static_configs:
 *         - targets: ["rackmap.example.com"]
 *
 * Everything here is a cheap aggregate query. Per-host series are intentionally
 * limited to state RackMap already stores (probe result, patch scan, open drift);
 * scraping live SSH metrics for the whole fleet on every scrape would open a
 * connection per server per interval. For live host metrics, point Prometheus at
 * node_exporter through /api/v1/prometheus/sd instead.
 *
 * Series added for heartbeats, patches and drift carry `server_id` next to the
 * hostname: hostnames are not unique, and the id joins against the
 * `rackmap_server_id` label that service discovery attaches to exporter targets.
 */

/** Window for the "recent activity" gauges (runbook runs, alert deliveries). */
const RECENT_WINDOW_MS = 24 * 3600 * 1000;

/** Escape a Prometheus label value per the exposition format. */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"')
    // The format defines no other escapes; a raw CR or NUL confuses some parsers.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ");
}

type Sample = { labels?: Record<string, string>; value: number };

/**
 * One sample per known status, zero-filled, plus any status the database holds
 * that the constants do not know yet. A status that drops to zero then reads 0
 * rather than vanishing, so dashboards and alerts on it keep working.
 */
function byStatus(known: readonly string[], rows: Array<{ status: string; _count: { _all: number } }>): Sample[] {
  const counts = new Map<string, number>(known.map((s) => [s, 0]));
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + row._count._all);
  return [...counts].map(([status, value]) => ({ labels: { status }, value }));
}

function renderMetric(name: string, help: string, type: "gauge" | "counter", samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const { labels, value } of samples) {
    if (!Number.isFinite(value)) continue;
    const labelPart = labels && Object.keys(labels).length > 0
      ? "{" + Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",") + "}"
      : "";
    lines.push(`${name}${labelPart} ${value}`);
  }
  return lines.join("\n");
}

export const metricsExportRoutes = new Hono()
  .use(requireSession)
  // Reading the endpoint reveals hostnames and fleet shape, so it needs at
  // least the same permission as listing servers.
  .use(requirePermission({ server: ["read"] }))
  .get("/", async (c) => {
    const now = Date.now();
    const since = new Date(now - RECENT_WINDOW_MS);
    const [
      serversByStatus,
      servicesByStatus,
      sslByStatus,
      servers,
      sslSoonest,
      heartbeats,
      heartbeatsByStatus,
      runsByStatus,
      deliveriesByStatus,
      patchStatuses,
      openDrift,
      activeGrants,
    ] = await Promise.all([
      prisma.server.groupBy({ by: ["lastStatus"], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.service.groupBy({ by: ["lastStatus"], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.sslStatus.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.server.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          hostname: true,
          ip: true,
          environment: true,
          lastStatus: true,
          lastLatencyMs: true,
          lastCheckedAt: true,
          gpuCount: true,
        },
      }),
      prisma.sslStatus.findMany({
        where: { deletedAt: null, daysRemaining: { not: null } },
        select: { domain: true, daysRemaining: true },
        orderBy: { daysRemaining: "asc" },
        take: 200,
      }),
      // Heartbeats are configuration rows (one per monitored job), not events,
      // so one sample each is bounded the same way servers are.
      prisma.heartbeat.findMany({
        select: { id: true, name: true, status: true, lastPingAt: true, server: { select: { hostname: true } } },
        orderBy: { id: "asc" },
      }),
      prisma.heartbeat.groupBy({ by: ["status"], _count: { _all: true } }),
      // Both event tables grow without bound; aggregate over the window only.
      prisma.runbookRun.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.alertDelivery.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      // At most one row per server (serverId is unique).
      prisma.serverPatchStatus.findMany({
        where: { server: { deletedAt: null } },
        select: {
          serverId: true,
          securityCount: true,
          upgradableCount: true,
          rebootRequired: true,
          server: { select: { hostname: true } },
        },
        orderBy: { serverId: "asc" },
      }),
      prisma.driftEvent.groupBy({
        by: ["serverId", "severity"],
        where: { acknowledgedAt: null, server: { deletedAt: null } },
        _count: { _all: true },
      }),
      prisma.accessGrant.count({ where: { status: "active" } }),
    ]);

    const blocks: string[] = [];
    const hostnameById = new Map(servers.map((s) => [s.id, s.hostname ?? ""]));

    blocks.push(
      renderMetric(
        "rackmap_servers_total",
        "Servers in inventory, by last probe status.",
        "gauge",
        serversByStatus.map((row) => ({
          labels: { status: row.lastStatus ?? "unknown" },
          value: row._count._all,
        })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_services_total",
        "Services in inventory, by last probe status.",
        "gauge",
        servicesByStatus.map((row) => ({
          labels: { status: row.lastStatus ?? "unknown" },
          value: row._count._all,
        })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_ssl_certificates_total",
        "Tracked TLS certificates, by status.",
        "gauge",
        sslByStatus.map((row) => ({
          labels: { status: row.status ?? "unknown" },
          value: row._count._all,
        })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_server_up",
        "Whether a server responded to its last TCP probe (1 = up, 0 = down).",
        "gauge",
        servers.map((s) => ({
          labels: {
            hostname: s.hostname ?? "",
            ip: s.ip ?? "",
            environment: s.environment ?? "unknown",
          },
          value: s.lastStatus === "up" ? 1 : 0,
        })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_server_probe_latency_ms",
        "Round-trip latency of the last successful TCP probe, in milliseconds.",
        "gauge",
        servers
          .filter((s) => typeof s.lastLatencyMs === "number")
          .map((s) => ({
            labels: { hostname: s.hostname ?? "" },
            value: s.lastLatencyMs as number,
          })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_server_last_probe_age_seconds",
        "Seconds since a server was last probed. A rising value means the scheduler is not running.",
        "gauge",
        servers
          .filter((s) => s.lastCheckedAt)
          .map((s) => ({
            labels: { hostname: s.hostname ?? "" },
            value: Math.round((now - (s.lastCheckedAt as Date).getTime()) / 1000),
          })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_server_gpu_count",
        "Number of GPUs recorded for a server.",
        "gauge",
        servers
          .filter((s) => (s.gpuCount ?? 0) > 0)
          .map((s) => ({ labels: { hostname: s.hostname ?? "" }, value: s.gpuCount as number })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_ssl_days_remaining",
        "Days until a tracked certificate expires. Negative means already expired.",
        "gauge",
        sslSoonest.map((s) => ({
          labels: { domain: s.domain },
          value: s.daysRemaining as number,
        })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_heartbeat_up",
        "Whether a heartbeat is healthy: 1 = up, or new and not yet due; 0 = late (past due, in grace) or down. Paused heartbeats are not exported.",
        "gauge",
        heartbeats
          .filter((h) => h.status !== "paused")
          .map((h) => ({
            labels: { heartbeat: h.name, heartbeat_id: String(h.id), server: h.server?.hostname ?? "" },
            value: h.status === "up" || h.status === "new" ? 1 : 0,
          })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_heartbeat_last_ping_age_seconds",
        "Seconds since a heartbeat last received a ping. Absent until the first ping.",
        "gauge",
        heartbeats
          .filter((h) => h.lastPingAt)
          .map((h) => ({
            labels: { heartbeat: h.name, heartbeat_id: String(h.id) },
            value: Math.max(0, Math.round((now - (h.lastPingAt as Date).getTime()) / 1000)),
          })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_heartbeats",
        "Heartbeats by current status (new, up, late, down, paused).",
        "gauge",
        byStatus(HEARTBEAT_STATUSES, heartbeatsByStatus),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_runbook_runs",
        "Runbook runs created in the last 24 hours, by current status.",
        "gauge",
        byStatus(RUNBOOK_RUN_STATUSES, runsByStatus),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_alert_deliveries",
        "Alert deliveries (one per event per channel) created in the last 24 hours, by current status.",
        "gauge",
        byStatus(ALERT_DELIVERY_STATUSES, deliveriesByStatus),
      ),
    );

    const patchLabels = (p: (typeof patchStatuses)[number]) => ({
      server: p.server.hostname ?? "",
      server_id: String(p.serverId),
    });

    blocks.push(
      renderMetric(
        "rackmap_patch_security_updates",
        "Pending security updates reported by a server's last patch scan.",
        "gauge",
        patchStatuses.map((p) => ({ labels: patchLabels(p), value: p.securityCount })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_patch_upgradable",
        "Upgradable packages (security or not) reported by a server's last patch scan.",
        "gauge",
        patchStatuses.map((p) => ({ labels: patchLabels(p), value: p.upgradableCount })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_patch_reboot_required",
        "Whether a server's last patch scan found a pending reboot (1 = reboot required).",
        "gauge",
        patchStatuses.map((p) => ({ labels: patchLabels(p), value: p.rebootRequired ? 1 : 0 })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_drift_open_events",
        "Unacknowledged configuration drift events, by server and severity. Absent means none open.",
        "gauge",
        openDrift.map((d) => ({
          labels: { server: hostnameById.get(d.serverId) ?? "", server_id: String(d.serverId), severity: d.severity },
          value: d._count._all,
        })),
      ),
    );

    blocks.push(
      renderMetric(
        "rackmap_access_grants_active",
        "Temporary access grants currently active (not yet expired or revoked).",
        "gauge",
        [{ value: activeGrants }],
      ),
    );

    return c.text(blocks.join("\n\n") + "\n", 200, {
      // Prometheus text exposition format, version 0.0.4.
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });
