import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import { prisma } from "../../db.js";

const createSchema = z.object({
  serverId: z.number().int().positive(),
  type: z.enum(["ssh", "password_reveal"]),
  note: z.string().max(500).optional(),
});

const resolveSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  adminNote: z.string().max(500).optional(),
  expiresInHours: z.number().int().min(1).max(720).optional(), // max 30 days
});

function getUser(c: { get: (k: string) => unknown }) {
  return c.get("user") as { id?: string; email?: string; role?: string } | undefined;
}

function requireAdmin(c: { get: (k: string) => unknown }) {
  const user = getUser(c);
  if (user?.role !== "admin") throw forbidden("Admin only");
}

export const accessRequestRoutes = new Hono()
  .use(requireSession)

  // GET /access-requests — admin: all; others: own
  .get("/", async (c) => {
    const user = getUser(c);
    if (!user?.id) throw forbidden();
    const isAdmin = user.role === "admin";

    const requests = await prisma.accessRequest.findMany({
      where: isAdmin ? {} : { requesterId: user.id },
      include: {
        requester: { select: { id: true, name: true, email: true } },
        server: { select: { id: true, hostname: true, ip: true } },
        resolver: { select: { id: true, name: true } },
      },
      orderBy: { requestedAt: "desc" },
      take: 200,
    });

    return c.json(requests);
  })

  // GET /access-requests/pending-count — admin badge count
  .get("/pending-count", async (c) => {
    requireAdmin(c);
    const count = await prisma.accessRequest.count({ where: { status: "pending" } });
    return c.json({ count });
  })

  // POST /access-requests — any authenticated user creates a request
  .post("/", zValidator("json", createSchema), async (c) => {
    const user = getUser(c);
    if (!user?.id) throw forbidden();
    const { serverId, type, note } = c.req.valid("json");

    const server = await prisma.server.findFirst({ where: { id: serverId, deletedAt: null } });
    if (!server) throw notFound("Server");

    // Cancel any existing pending request for same user+server+type
    await prisma.accessRequest.updateMany({
      where: { requesterId: user.id, serverId, type, status: "pending" },
      data: { status: "rejected", adminNote: "Superseded by new request" },
    });

    const req = await prisma.accessRequest.create({
      data: { requesterId: user.id, serverId, type, note },
    });

    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "data",
      action: "access_request.create",
      entity: "AccessRequest",
      entityId: String(req.id),
      after: { type, serverId, hostname: server.hostname },
    });

    return c.json(req, 201);
  })

  // PATCH /access-requests/:id — admin approves/rejects
  .patch("/:id", zValidator("json", resolveSchema), async (c) => {
    requireAdmin(c);
    const user = getUser(c);
    const id = Number(c.req.param("id"));
    const { status, adminNote, expiresInHours } = c.req.valid("json");

    const existing = await prisma.accessRequest.findUnique({ where: { id } });
    if (!existing) throw notFound("Access request");
    if (existing.status !== "pending") throw forbidden("Request already resolved");

    const expiresAt = status === "approved" && expiresInHours
      ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
      : status === "approved"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000) // default 24h
        : null;

    const updated = await prisma.accessRequest.update({
      where: { id },
      data: {
        status,
        adminNote,
        resolvedAt: new Date(),
        resolvedBy: user?.id,
        expiresAt,
      },
    });

    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "data",
      action: status === "approved" ? "access_request.approved" : "access_request.rejected",
      entity: "AccessRequest",
      entityId: String(id),
      after: { status, type: existing.type, serverId: existing.serverId, adminNote, expiresAt },
    });

    return c.json(updated);
  })

  // DELETE /access-requests/:id — admin removes old request
  .delete("/:id", async (c) => {
    requireAdmin(c);
    const id = Number(c.req.param("id"));
    const existing = await prisma.accessRequest.findUnique({ where: { id } });
    if (!existing) throw notFound("Access request");
    await prisma.accessRequest.delete({ where: { id } });
    return c.json({ ok: true });
  })

  // GET /access-requests/check — viewer checks if they have valid approval for a server+type
  .get("/check", async (c) => {
    const user = getUser(c);
    if (!user?.id) throw forbidden();
    const serverId = Number(c.req.query("serverId"));
    const type = c.req.query("type") as "ssh" | "password_reveal";

    if (!serverId || !type) return c.json({ approved: false });

    const request = await prisma.accessRequest.findFirst({
      where: {
        requesterId: user.id,
        serverId,
        type,
        status: "approved",
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
    });

    return c.json({ approved: !!request, expiresAt: request?.expiresAt ?? null });
  });
