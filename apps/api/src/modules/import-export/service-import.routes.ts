import { Hono } from "hono";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { importServices, exportServices, exportServicesJson } from "./service-import.service.js";

const serviceImportRoutes = new Hono();

// POST /services/import — multipart, editor+
serviceImportRoutes.post("/import", requireSession, requirePermission({ service: ["create"] }), async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const mappingRaw = formData.get("mapping");
  const dryRun = formData.get("dryRun") === "true";

  if (!file) return c.json({ error: { code: "MISSING_FILE", message: "file field required" } }, 400);

  let mapping: Record<string, string>;
  try {
    mapping = JSON.parse(typeof mappingRaw === "string" ? mappingRaw : "{}") as Record<string, string>;
  } catch {
    return c.json({ error: { code: "INVALID_MAPPING", message: "mapping must be valid JSON" } }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ctx = getAuditCtx(c);

  try {
    const result = await importServices(buffer, file.type, mapping, dryRun, ctx);
    return c.json(result, 200);
  } catch (err: unknown) {
    return c.json({ error: { code: "IMPORT_FAILED", message: (err as Error).message } }, 422);
  }
});

// GET /services/export.xlsx — viewer+
serviceImportRoutes.get("/export.xlsx", requireSession, async (c) => {
  const filters: Record<string, string | undefined> = {
    q: c.req.query("q"),
  };

  const buf = await exportServices(filters);
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="services-${Date.now()}.xlsx"`,
    },
  });
});

// GET /services/export.json — viewer+
serviceImportRoutes.get("/export.json", requireSession, async (c) => {
  const filters: Record<string, string | undefined> = {
    q: c.req.query("q"),
  };

  const json = await exportServicesJson(filters);
  return new Response(json, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="services-${Date.now()}.json"`,
    },
  });
});

export { serviceImportRoutes };
