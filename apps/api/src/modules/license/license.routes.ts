import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { requireSession } from "../../middleware/session.js";
import { forbidden } from "../../lib/errors.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import {
  getLicenseStatus,
  activateLicense,
  deactivateLicense,
} from "../../services/license.service.js";
import { ActivateLicenseRequestSchema } from "@inv/shared";

export const licenseRoutes = new Hono();

licenseRoutes.use("/*", requireSession);

/** GET /api/v1/license — retrieve current subscription & feature entitlements */
licenseRoutes.get("/", async (c) => {
  const status = await getLicenseStatus();
  return c.json(status);
});

/** POST /api/v1/license/activate — activate a Licencia key or offline lease token (Admin only) */
licenseRoutes.post(
  "/activate",
  zValidator("json", ActivateLicenseRequestSchema),
  async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") {
      throw forbidden("Admin access required to activate a license");
    }
    const body = c.req.valid("json");
    const status = await activateLicense(body);

    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "security",
      action: "license.activate",
      entity: "SystemLicense",
      entityId: "1",
      after: {
        tier: status.tier,
        maxServers: status.maxServers,
        expiresAt: status.expiresAt,
      },
    });

    return c.json(status);
  }
);

/** POST /api/v1/license/deactivate — deactivate current license and return to Free tier (Admin only) */
licenseRoutes.post("/deactivate", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    throw forbidden("Admin access required to deactivate a license");
  }
  const status = await deactivateLicense();

  await writeAuditDirect({
    ctx: getAuditCtx(c),
    category: "security",
    action: "license.deactivate",
    entity: "SystemLicense",
    entityId: "1",
    after: {
      tier: "free",
    },
  });

  return c.json(status);
});
