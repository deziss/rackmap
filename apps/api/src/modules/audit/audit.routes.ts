import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { prisma } from "../../db.js";

const auditQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  category: z.string().optional(),
  entity: z.string().optional(),
  entityId: z.string().optional(),
  action: z.string().optional(),
  actorId: z.string().optional(),
  search: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const auditRoutes = new Hono()
  .use(requireSession)
  .use(requirePermission({ audit: ["read"] }))

  .get("/", zValidator("query", auditQuerySchema), async (c) => {
    const { cursor, limit, category, entity, entityId, action, actorId, search, from, to } = c.req.valid("query");

    const baseWhere = {
      ...(category ? { category } : {}),
      ...(entity ? { entity: { contains: entity } } : {}),
      ...(entityId ? { entityId: { contains: entityId } } : {}),
      ...(action ? { action: { contains: action } } : {}),
      ...(actorId ? { actorId } : {}),
      ...(search ? {
        OR: [
          { beforeJson: { contains: search } },
          { afterJson: { contains: search } },
          { diffJson: { contains: search } },
          { entityId: { contains: search } },
          { entity: { contains: search } },
          { action: { contains: search } },
          { ip: { contains: search } },
          { actorEmail: { contains: search } },
        ]
      } : {}),
      ...(from || to ? {
        createdAt: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      } : {}),
    };

    const where = {
      ...baseWhere,
      ...(cursor ? { id: { lt: cursor } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { id: "desc" },
        take: limit,
      }),
      prisma.auditLog.count({ where: baseWhere }),
    ]);

    const serverIds = [...new Set(items.filter(i => i.entity === "server").map(i => parseInt(i.entityId || "")).filter(id => !isNaN(id)))];
    const serviceIds = [...new Set(items.filter(i => i.entity === "service").map(i => parseInt(i.entityId || "")).filter(id => !isNaN(id)))];
    const userIds = [...new Set(items.filter(i => i.entity?.toLowerCase() === "user").map(i => i.entityId!).filter(Boolean))];

    const [servers, services, users] = await Promise.all([
      serverIds.length ? prisma.server.findMany({ where: { id: { in: serverIds } }, select: { id: true, ip: true, domain: true, hostname: true } }) : [],
      serviceIds.length ? prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, serviceName: true, serverIp: true, domain: true } }) : [],
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : []
    ]);

    const serverMap = Object.fromEntries(servers.map(s => [String(s.id), [s.hostname, s.domain, s.ip].filter(Boolean).join(" | ")]));
    const serviceMap = Object.fromEntries(services.map(s => [String(s.id), [s.serviceName, s.domain, s.serverIp].filter(Boolean).join(" | ")]));
    const userMap = Object.fromEntries(users.map(u => [u.id, [u.name, u.email].filter(Boolean).join(" | ")]));

    const enrichedItems = items.map(item => {
      let entityName = undefined;
      if (item.entity === "server" && item.entityId) entityName = serverMap[item.entityId];
      if (item.entity === "service" && item.entityId) entityName = serviceMap[item.entityId];
      if (item.entity?.toLowerCase() === "user" && item.entityId) entityName = userMap[item.entityId];
      return { ...item, entityName };
    });

    const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
    return c.json({ items: enrichedItems, nextCursor, total });
  });
