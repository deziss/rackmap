import { Hono } from "hono";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";

/**
 * Prometheus exposition endpoint.
 *
 * RackMap deliberately does not persist a time series of its own: live CPU,
 * memory, disk and GPU readings are collected over SSH on demand and discarded.
 * Building a TSDB inside SQLite would be the wrong tool. Exposing the current
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
 * limited to up/down and probe latency; scraping live SSH metrics for the whole
 * fleet on every scrape would open a connection per server per interval.
 */

/** Escape a Prometheus label value per the exposition format. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

type Sample = { labels?: Record<string, string>; value: number };

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
    const [serversByStatus, servicesByStatus, sslByStatus, servers, sslSoonest] = await Promise.all([
      prisma.server.groupBy({ by: ["lastStatus"], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.service.groupBy({ by: ["lastStatus"], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.sslStatus.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.server.findMany({
        where: { deletedAt: null },
        select: {
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
    ]);

    const now = Date.now();
    const blocks: string[] = [];

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

    return c.text(blocks.join("\n\n") + "\n", 200, {
      // Prometheus text exposition format, version 0.0.4.
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });
