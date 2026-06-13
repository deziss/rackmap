import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import { prisma } from "../../db.js";
import { auth } from "../../auth.js";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
});

const passwordSchema = z.object({
  newPassword: z.string().min(8).max(512),
});

function requireAdmin(c: { get: (k: string) => unknown }) {
  const user = c.get("user") as { role?: string } | undefined;
  if (user?.role !== "admin") throw forbidden("Admin only");
}

export const userRoutes = new Hono()
  .use(requireSession)

  // PATCH /users/:id — admin updates user name/email
  .patch(
    "/:id",
    zValidator("json", updateSchema),
    async (c) => {
      requireAdmin(c);
      const id = c.req.param("id");
      const { name, email } = c.req.valid("json");

      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) throw notFound("User");

      const updated = await prisma.user.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(email !== undefined ? { email } : {}),
        },
      });

      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "auth",
        action: "user.update",
        entity: "User",
        entityId: id,
        before: { name: existing.name, email: existing.email },
        after: { name: updated.name, email: updated.email },
      });

      return c.json({ id: updated.id, name: updated.name, email: updated.email });
    },
  )

  // POST /users/:id/set-password — admin sets user password
  .post(
    "/:id/set-password",
    zValidator("json", passwordSchema),
    async (c) => {
      requireAdmin(c);
      const userId = c.req.param("id");
      const { newPassword } = c.req.valid("json");

      const existing = await prisma.user.findUnique({ where: { id: userId } });
      if (!existing) throw notFound("User");

      // Use Better Auth admin plugin to set another user's password (handles hashing)
      const res = await auth.api.setUserPassword({
        headers: c.req.raw.headers,
        body: { userId, newPassword },
      });
      if (!res) throw new Error("Failed to set password");

      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "auth",
        action: "auth.password_reset_by_admin",
        entity: "User",
        entityId: userId,
        after: { targetEmail: existing.email },
      });

      return c.json({ ok: true });
    },
  )

  // DELETE /users/:id — admin removes user
  .delete("/:id", async (c) => {
    requireAdmin(c);
    const id = c.req.param("id");
    const actor = c.get("user") as { id?: string } | undefined;

    if (actor?.id === id) throw forbidden("Cannot delete yourself");

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw notFound("User");

    await prisma.user.delete({ where: { id } });

    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "auth",
      action: "user.remove",
      entity: "User",
      entityId: id,
      before: { name: existing.name, email: existing.email },
    });

    return c.json({ ok: true });
  });
