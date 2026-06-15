import { Hono } from "hono";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { importServers, exportServers, exportServersJson } from "./import.service.js";

const importRoutes = new Hono();

// POST /servers/import — multipart, editor+
importRoutes.post("/import", requireSession, requirePermission({ server: ["create"] }), async (c) => {
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
    const result = await importServers(buffer, file.type, mapping, dryRun, ctx);
    return c.json(result, 200);
  } catch (err: unknown) {
    return c.json({ error: { code: "IMPORT_FAILED", message: (err as Error).message } }, 422);
  }
});

// GET /servers/export.xlsx — viewer+
importRoutes.get("/export.xlsx", requireSession, async (c) => {
  const filters: Record<string, string | undefined> = {
    q: c.req.query("q"),
    cloudProviderId: c.req.query("cloudProviderId"),
    gpuTypeId: c.req.query("gpuTypeId"),
    allocatedToId: c.req.query("allocatedToId"),
    locationId: c.req.query("locationId"),
    serverTypeId: c.req.query("serverTypeId"),
    status: c.req.query("status"),
  };

  const buf = await exportServers(filters);
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="servers-${Date.now()}.xlsx"`,
    },
  });
});

// GET /servers/export.json — viewer+
importRoutes.get("/export.json", requireSession, async (c) => {
  const filters: Record<string, string | undefined> = {
    q: c.req.query("q"),
    cloudProviderId: c.req.query("cloudProviderId"),
    gpuTypeId: c.req.query("gpuTypeId"),
    allocatedToId: c.req.query("allocatedToId"),
    locationId: c.req.query("locationId"),
    serverTypeId: c.req.query("serverTypeId"),
    status: c.req.query("status"),
  };

  const json = await exportServersJson(filters);
  return new Response(json, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="servers-${Date.now()}.json"`,
    },
  });
});

export { importRoutes };
