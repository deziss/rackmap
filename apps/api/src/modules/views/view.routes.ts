import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { notFound } from "../../lib/errors.js";

const viewRoutes = new Hono();

const CreateViewSchema = z.object({
  name: z.string().min(1).max(80),
  paramsJson: z.string().min(1),
});

// GET /views — list own views
viewRoutes.get("/", requireSession, async (c) => {
  const user = c.get("user");
  const views = await prisma.savedView.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, paramsJson: true, createdAt: true, updatedAt: true },
  });
  return c.json(views);
});

// POST /views
viewRoutes.post("/", requireSession, async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = CreateViewSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid input", details: parsed.error.flatten() } }, 400);

  const view = await prisma.savedView.create({
    data: { userId: user.id, name: parsed.data.name, paramsJson: parsed.data.paramsJson },
    select: { id: true, name: true, paramsJson: true, createdAt: true, updatedAt: true },
  });
  return c.json(view, 201);
});

// PATCH /views/:id
viewRoutes.patch("/:id", requireSession, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const parsed = CreateViewSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid input" } }, 400);

  const existing = await prisma.savedView.findUnique({ where: { id } });
  if (!existing || existing.userId !== user.id) throw notFound("SavedView");

  const view = await prisma.savedView.update({
    where: { id },
    data: parsed.data,
    select: { id: true, name: true, paramsJson: true, createdAt: true, updatedAt: true },
  });
  return c.json(view);
});

// DELETE /views/:id
viewRoutes.delete("/:id", requireSession, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const existing = await prisma.savedView.findUnique({ where: { id } });
  if (!existing || existing.userId !== user.id) throw notFound("SavedView");
  await prisma.savedView.delete({ where: { id } });
  return c.json({ ok: true });
});

export { viewRoutes };
