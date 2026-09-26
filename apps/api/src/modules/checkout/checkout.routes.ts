import { Hono } from "hono";
import type { Context, Next } from "hono";
import { zValidator } from "@hono/zod-validator";
import { requireSession } from "../../middleware/session.js";
import { forbidden } from "../../lib/errors.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import {
  CreateCheckoutSessionSchema,
  CompleteCheckoutSchema,
} from "@inv/shared";
import {
  createCheckoutSession,
  completeCheckout,
  getUserOrders,
  getOrderById,
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

/**
 * Buying a plan changes the licence of the whole instance (auto-activation
 * replaces the system licence), so it is an admin action — the same rule as
 * POST /license/activate. Checked before body validation so a non-admin learns
 * nothing about the expected payload.
 */
async function requireAdmin(c: Context, next: Next) {
  const user = c.get("user") as { role?: string } | undefined;
  if (user?.role !== "admin") {
    throw forbidden("Admin access required to purchase a subscription");
  }
  return next();
}

/** POST /api/v1/checkout/session — initiate a checkout order (Admin only) */
checkoutRoutes.post(
  "/session",
  requireAdmin,
  zValidator("json", CreateCheckoutSessionSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const session = await createCheckoutSession(user.id, body);
    return c.json(session);
  }
);

/**
 * POST /api/v1/checkout/complete — finalize payment & receive Licencia key (Admin only).
 * 501 unless BILLING_MODE=simulated: there is no payment gateway to verify against.
 */
checkoutRoutes.post(
  "/complete",
  requireAdmin,
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

/** GET /api/v1/checkout/orders/:id — retrieve single invoice & order details */
checkoutRoutes.get("/orders/:id", async (c) => {
  const user = c.get("user");
  const orderId = c.req.param("id");
  const order = await getOrderById(orderId, user.id, user.role === "admin");
  return c.json({ order });
});
