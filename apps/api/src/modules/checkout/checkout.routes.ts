import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { requireSession } from "../../middleware/session.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import {
  CreateCheckoutSessionSchema,
  CompleteCheckoutSchema,
} from "@inv/shared";
import {
  createCheckoutSession,
  completeCheckout,
  getUserOrders,
} from "../../services/checkout.service.js";

export const checkoutRoutes = new Hono();

/** GET /api/v1/checkout/plans — public catalog of available subscription plans */
checkoutRoutes.get("/plans", (c) => {
  return c.json({
    plans: [
      {
        id: "free",
        name: "Community Edition",
        monthlyPrice: 0,
        annualPrice: 0,
        maxServers: 10,
        description: "Open source core for personal homelabs and small environments",
      },
      {
        id: "pro",
        name: "RackMap Professional",
        monthlyPrice: 39,
        annualPrice: 31,
        maxServers: 100,
        description: "For growing teams needing ATOP performance replay and remote OS user management",
      },
      {
        id: "enterprise",
        name: "RackMap Enterprise",
        monthlyPrice: 249,
        annualPrice: 199,
        maxServers: -1,
        description: "For mission-critical infrastructure with air-gapped activation and custom SLAs",
      },
    ],
  });
});

// All subsequent checkout routes require an active authenticated user session
checkoutRoutes.use("/*", requireSession);

/** POST /api/v1/checkout/session — initiate a checkout order */
checkoutRoutes.post(
  "/session",
  zValidator("json", CreateCheckoutSessionSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const session = await createCheckoutSession(user.id, body);
    return c.json(session);
  }
);

/** POST /api/v1/checkout/complete — finalize payment & receive Licencia key */
checkoutRoutes.post(
  "/complete",
  zValidator("json", CompleteCheckoutSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const result = await completeCheckout(user.id, body);

    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "security",
      action: "checkout.complete",
      entity: "Order",
      entityId: result.orderId,
      after: {
        tier: result.tier,
        invoiceNumber: result.invoiceNumber,
        activated: result.activated,
      },
    });

    return c.json(result);
  }
);

/** GET /api/v1/checkout/orders — list customer orders */
checkoutRoutes.get("/orders", async (c) => {
  const user = c.get("user");
  const orders = await getUserOrders(user.id, user.role === "admin");
  return c.json({ orders });
});
