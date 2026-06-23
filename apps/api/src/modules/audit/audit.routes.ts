import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { prisma } from "../../db.js";

const auditQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  category: z.enum(["data", "auth"]).optional(),
  entity: z.string().optional(),
  entityId: z.string().optional(),
  action: z.string().optional(),
  actorId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const auditRoutes = new Hono()
  .use(requireSession)
  .use(requirePermission({ audit: ["read"] }))

  .get("/", zValidator("query", auditQuerySchema), async (c) => {
    const { cursor, limit, category, entity, entityId, action, actorId, from, to } = c.req.valid("query");

    const where = {
      ...(cursor ? { id: { lt: cursor } } : {}),
      ...(category ? { category } : {}),
      ...(entity ? { entity: { contains: entity } } : {}),
      ...(entityId ? { entityId: { contains: entityId } } : {}),
      ...(action ? { action: { contains: action } } : {}),
      ...(actorId ? { actorId } : {}),
      ...(from || to ? {
        createdAt: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      } : {}),
    };

    const items = await prisma.auditLog.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit,
    });

    const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
    return c.json({ items, nextCursor });
  });
