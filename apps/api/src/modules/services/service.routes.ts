import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { ServiceCreateInput, ServiceUpdateInput, ServiceListQuery } from "@inv/shared";
import {
  listServices,
  getService,
  createService,
  updateService,
  softDeleteService,
  restoreService,
  revealServicePassword,
} from "./service.service.js";
import { runServiceCheck, runAllServices } from "../../services/service-status.service.js";
import { prisma } from "../../db.js";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const serviceRoutes = new Hono()
  .use(requireSession)

  .get("/", zValidator("query", ServiceListQuery), async (c) => {
    const user = c.get("user");
    const query = c.req.valid("query");
    const isAdmin = user.role === "admin";
    return c.json(await listServices(query, isAdmin));
  })

  .post(
    "/",
    requirePermission({ server: ["create"] }), // Reusing server permission or could be a dedicated one
    zValidator("json", ServiceCreateInput),
    async (c) => {
      const input = c.req.valid("json");
      const dto = await createService(input, getAuditCtx(c));
      return c.json(dto, 201);
    },
  )

  .get("/:id", zValidator("param", idParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await getService(id));
  })

  .patch(
    "/:id",
    requirePermission({ server: ["update"] }),
    zValidator("param", idParamSchema),
    zValidator("json", ServiceUpdateInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      return c.json(await updateService(id, input, getAuditCtx(c)));
    },
  )

  .delete(
    "/:id",
    requirePermission({ server: ["delete"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      await softDeleteService(id, getAuditCtx(c));
      return c.json({ ok: true });
    },
  )

  .post(
    "/:id/restore",
    requirePermission({ server: ["restore"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await restoreService(id, getAuditCtx(c)));
    },
  )

  .post(
    "/:id/reveal-password",
    zValidator("param", idParamSchema),
    async (c) => {
      const user = c.get("user") as { id?: string; role?: string } | undefined;
      if (!user?.id) return c.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
      const { id } = c.req.valid("param");

      const hasDirectPerm = user.role === "admin" || user.role === "editor";
      if (!hasDirectPerm) {
        // Check for valid approved AccessRequest
        const req = await prisma.accessRequest.findFirst({
          where: {
            requesterId: user.id,
            serviceId: id,
            type: "service_password_reveal",
            status: "approved",
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        });
        if (!req) return c.json({ error: { code: "FORBIDDEN", message: "Request access to reveal this password" } }, 403);
      }

      const password = await revealServicePassword(id, getAuditCtx(c));
      return c.json({ password });
    },
  )

  .post(
    "/:id/check",
    requirePermission({ server: ["check"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const result = await runServiceCheck(id);
      if (!result) return c.json({ error: { code: "NOT_FOUND", message: "Service not found" } }, 404);
      return c.json(result);
    },
  )

  .post(
    "/check-all",
    requirePermission({ server: ["check"] }),
    async (c) => {
      const results = await runAllServices();
      return c.json({ checked: results.length });
    },
  );
