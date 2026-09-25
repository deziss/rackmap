import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  DRIFT_SEVERITY_RANK,
  DriftEventsQuery,
  type DriftAcknowledgeResponse,
  type DriftEventListResponse,
  type DriftSeverity,
  type DriftSummaryResponse,
} from "@inv/shared";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { buildCursorWhere, getNextCursor } from "../../lib/pagination.js";
import {
  DRIFT_EVENT_INCLUDE,
  acknowledgeDriftEvent,
  addCount,
  emptyCounts,
  toDriftEventDto,
} from "../../services/drift.service.js";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** Mounted at /api/v1/drift  (fleet events). */
export const driftRoutes = new Hono()
  // GET /drift/events — newest first, keyset-paginated on id
  .get(
    "/events",
    requireSession,
    requirePermission({ drift: ["read"] }),
    zValidator("query", DriftEventsQuery),
    async (c) => {
      const q = c.req.valid("query");
      const rows = await prisma.driftEvent.findMany({
        where: {
          ...buildCursorWhere(q.cursor),
          ...(q.status === "open" ? { acknowledgedAt: null } : {}),
          ...(q.serverId ? { serverId: q.serverId } : {}),
          ...(q.severity ? { severity: q.severity } : {}),
          ...(q.category ? { category: q.category } : {}),
          server: { deletedAt: null },
        },
        orderBy: { id: "desc" },
        take: q.limit,
        include: DRIFT_EVENT_INCLUDE,
      });
      const body: DriftEventListResponse = { items: rows.map(toDriftEventDto), nextCursor: getNextCursor(rows, q.limit) };
      return c.json(body);
    },
  )

  // GET /drift/summary — open events by severity, and the servers that have them
  .get("/summary", requireSession, requirePermission({ drift: ["read"] }), async (c) => {
    const grouped = await prisma.driftEvent.groupBy({
      by: ["serverId", "severity"],
      where: { acknowledgedAt: null, server: { deletedAt: null } },
      _count: { _all: true },
      _max: { detectedAt: true },
    });
    const open = emptyCounts();
    const perServer = new Map<number, { open: number; maxSeverity: DriftSeverity; lastDetectedAt: Date }>();
    for (const g of grouped) {
      const n = g._count._all;
      addCount(open, g.severity, n);
      const severity = (g.severity in DRIFT_SEVERITY_RANK ? g.severity : "warning") as DriftSeverity;
      const at = g._max.detectedAt ?? new Date(0);
      const s = perServer.get(g.serverId);
      if (!s) {
        perServer.set(g.serverId, { open: n, maxSeverity: severity, lastDetectedAt: at });
      } else {
        s.open += n;
        if (DRIFT_SEVERITY_RANK[severity] > DRIFT_SEVERITY_RANK[s.maxSeverity]) s.maxSeverity = severity;
        if (at > s.lastDetectedAt) s.lastDetectedAt = at;
      }
    }
    const hosts = await prisma.server.findMany({
      where: { id: { in: [...perServer.keys()] } },
      select: { id: true, hostname: true },
    });
    const hostname = new Map(hosts.map((h) => [h.id, h.hostname]));
    const servers = [...perServer.entries()]
      .map(([serverId, s]) => ({
        serverId,
        hostname: hostname.get(serverId) ?? `#${serverId}`,
        open: s.open,
        maxSeverity: s.maxSeverity,
        lastDetectedAt: s.lastDetectedAt.toISOString(),
      }))
      .sort(
        (a, b) =>
          DRIFT_SEVERITY_RANK[b.maxSeverity] - DRIFT_SEVERITY_RANK[a.maxSeverity] ||
          b.open - a.open ||
          a.hostname.localeCompare(b.hostname),
      );
    const body: DriftSummaryResponse = { open, servers };
    return c.json(body);
  })

  // POST /drift/events/:id/acknowledge — mark one event as seen (audited)
  .post(
    "/events/:id/acknowledge",
    requireSession,
    requirePermission({ drift: ["acknowledge"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body: DriftAcknowledgeResponse = { event: await acknowledgeDriftEvent(id, getAuditCtx(c)) };
      return c.json(body);
    },
  );
