import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { LOOKUP_TYPE_KEYS, type LookupType } from "@inv/shared";
import { listLookups, createLookup, updateLookup, deleteLookup } from "./lookup.service.js";
import { notFound } from "../../lib/errors.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";

const nameSchema = z.object({ name: z.string().min(1).max(100).trim() });
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function parseLookupType(raw: string): LookupType {
  if (!LOOKUP_TYPE_KEYS.includes(raw as LookupType)) throw notFound("Lookup type");
  return raw as LookupType;
}

export const lookupRoutes = new Hono()
  .use(requireSession)

  // GET /lookups/:type — viewers can read
  .get("/:type", async (c) => {
    const type = parseLookupType(c.req.param("type"));
    return c.json(await listLookups(type));
  })

  // POST /lookups/:type — editor+
  .post(
    "/:type",
    requirePermission({ lookup: ["create"] }),
    zValidator("json", nameSchema),
    async (c) => {
      const type = parseLookupType(c.req.param("type"));
      const { name } = c.req.valid("json");
      const created = await createLookup(type, name);
      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "data",
        action: "lookup.create",
        entity: "Lookup",
        entityId: String(created.id),
        after: { type, name: created.name },
      });
      return c.json(created, 201);
    },
  )

  // PATCH /lookups/:type/:id — editor+
  .patch(
    "/:type/:id",
    requirePermission({ lookup: ["update"] }),
    zValidator("json", nameSchema),
    zValidator("param", idParamSchema),
    async (c) => {
      const type = parseLookupType(c.req.param("type"));
      const { id } = c.req.valid("param");
      const { name } = c.req.valid("json");
      const before = await listLookups(type).then((list) => list.find((e) => e.id === id) ?? null);
      const updated = await updateLookup(type, id, name);
      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "data",
        action: "lookup.update",
        entity: "Lookup",
        entityId: String(id),
        before: before ? { type, name: before.name } : null,
        after: { type, name: updated.name },
      });
      return c.json(updated);
    },
  )

  // DELETE /lookups/:type/:id — admin only
  .delete(
    "/:type/:id",
    requirePermission({ lookup: ["delete"] }),
    zValidator("param", idParamSchema),
    async (c) => {
      const type = parseLookupType(c.req.param("type"));
      const { id } = c.req.valid("param");
      const deleted = await deleteLookup(type, id);
      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "data",
        action: "lookup.delete",
        entity: "Lookup",
        entityId: String(id),
        before: { type, name: deleted.name },
      });
      return c.json({ ok: true });
    },
  );
