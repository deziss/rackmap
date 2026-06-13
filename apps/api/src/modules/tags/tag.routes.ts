import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { prisma } from "../../db.js";
import { notFound, conflict } from "../../lib/errors.js";

const tagBodySchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const tagRoutes = new Hono()
  .use(requireSession)

  // GET /tags — all authenticated
  .get("/", async (c) => {
    return c.json(await prisma.tag.findMany({ orderBy: { name: "asc" } }));
  })

  // POST /tags — editor+
  .post(
    "/",
    requirePermission({ tag: ["create"] }),
    zValidator("json", tagBodySchema),
    async (c) => {
      const { name, color } = c.req.valid("json");
      const existing = await prisma.tag.findUnique({ where: { name } });
      if (existing) throw conflict(`Tag "${name}" already exists`);
      const tag = await prisma.tag.create({ data: { name, color: color ?? null } });
      return c.json(tag, 201);
    },
  )

  // DELETE /tags/:id — admin only
  .delete(
    "/:id",
    requirePermission({ tag: ["delete"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const existing = await prisma.tag.findUnique({ where: { id } });
      if (!existing) throw notFound("Tag");
      await prisma.tag.delete({ where: { id } });
      return c.json({ ok: true });
    },
  );
