import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Prisma } from "@prisma/client";
import { PrometheusSdQuery, type PrometheusSdTargetGroup } from "@inv/shared";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";

/**
 * Prometheus HTTP service discovery.
 *
 * Returns the fleet in the `http_sd_configs` format so Prometheus scrapes an
 * exporter on every server RackMap knows about — one inventory instead of a
 * RackMap list plus a hand-edited `file_sd` file that drifts out of date.
 *
 *   scrape_configs:
 *     - job_name: node
 *       http_sd_configs:
 *         - url: https://rackmap.example.com/api/v1/prometheus/sd?port=9100
 *           authorization:
 *             type: Bearer
 *             credentials_file: /etc/prometheus/rackmap.key
 *
 * Authentication and permission match /api/v1/metrics: a session or a
 * `Bearer sk_…` API key holding server:read. The response reveals hostnames
 * and addresses, which is exactly what listing servers already reveals.
 *
 * One query, one row per server, no per-server follow-ups: Prometheus refreshes
 * this every `refresh_interval` (1m by default) from every Prometheus replica.
 */

/** Postgres int4 upper bound — a larger numeric `location` can only be a name. */
const MAX_INT4 = 2_147_483_647;

/** Label values must be plain strings: no control characters, bounded length. */
function labelValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 256);
}

/**
 * `,a,b,` — sorted, comma-wrapped, so `regex: ".*,web,.*"` matches exactly one
 * tag. A comma inside a tag name would split it, so it is replaced with `_`.
 */
function tagsLabel(names: string[]): string {
  if (names.length === 0) return "";
  const clean = names.map((n) => labelValue(n).replace(/,/g, "_")).filter(Boolean).sort();
  return clean.length > 0 ? `,${clean.join(",")},` : "";
}

/**
 * `host:port`, bracketing an IPv6 literal. Returns null when the host is empty
 * or cannot form a valid target (whitespace, a path, a scheme), so one bad row
 * never hands Prometheus an unparseable address.
 */
function targetAddress(host: string | null | undefined, port: number): string | null {
  const h = (host ?? "").trim();
  if (!h || /[\s/\\@]/.test(h)) return null;
  if (h.startsWith("[") && h.endsWith("]")) return `${h}:${port}`;
  if (h.includes(":")) return `[${h}]:${port}`;
  return `${h}:${port}`;
}

export const prometheusSdRoutes = new Hono()
  .use(requireSession)
  .get("/sd", requirePermission({ server: ["read"] }), zValidator("query", PrometheusSdQuery), async (c) => {
    const q = c.req.valid("query");
    const port = q.port ?? env.PROMETHEUS_SD_DEFAULT_PORT;

    const and: Prisma.ServerWhereInput[] = [{ deletedAt: null }];
    if (q.environment) {
      and.push({ environment: { equals: q.environment, mode: "insensitive" } });
    }
    if (q.location) {
      const byName: Prisma.ServerWhereInput = { location: { name: { equals: q.location, mode: "insensitive" } } };
      const asId = /^\d+$/.test(q.location) ? Number(q.location) : null;
      and.push(asId !== null && asId <= MAX_INT4 ? { OR: [{ locationId: asId }, byName] } : byName);
    }
    for (const tag of q.tag) {
      and.push({ tags: { some: { tag: { name: { equals: tag, mode: "insensitive" } } } } });
    }
    if (q.status) and.push({ lastStatus: q.status });
    if (q.excludeDown) and.push({ lastStatus: { not: "down" } });

    const servers = await prisma.server.findMany({
      where: { AND: and },
      select: {
        id: true,
        hostname: true,
        ip: true,
        environment: true,
        lastStatus: true,
        location: { select: { name: true } },
        serverType: { select: { name: true } },
        tags: { select: { tag: { select: { name: true } } } },
      },
      orderBy: { id: "asc" },
    });

    const groups: PrometheusSdTargetGroup[] = [];
    for (const s of servers) {
      const [preferred, fallback] = q.address === "hostname" ? [s.hostname, s.ip] : [s.ip, s.hostname];
      const target = targetAddress(preferred, port) ?? targetAddress(fallback, port);
      if (!target) continue;
      groups.push({
        targets: [target],
        labels: {
          rackmap_server_id: String(s.id),
          rackmap_hostname: labelValue(s.hostname),
          rackmap_environment: labelValue(s.environment),
          rackmap_location: labelValue(s.location?.name),
          rackmap_server_type: labelValue(s.serverType?.name),
          rackmap_status: labelValue(s.lastStatus) || "unknown",
          rackmap_tags: tagsLabel(s.tags.map((t) => t.tag.name)),
        },
      });
    }

    c.header("Cache-Control", "no-store");
    return c.json(groups, 200);
  });
