import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import { prisma } from "../db.js";
import { env } from "../env.js";

const app = createApp();

let adminCookie = "";
let editorCookie = "";
let viewerCookie = "";

// env is parsed once at import; the billing gate reads env.BILLING_MODE on every
// call, so the object is switched per test and restored afterwards.
const savedEnv = { billing: env.BILLING_MODE, nodeEnv: env.NODE_ENV, licenciaUrl: env.LICENCIA_URL };

beforeAll(async () => {
  [adminCookie, editorCookie, viewerCookie] = await Promise.all([
    loginAs(app, "admin"),
    loginAs(app, "editor"),
    loginAs(app, "viewer"),
  ]);
});

afterEach(() => {
  env.BILLING_MODE = savedEnv.billing;
  env.NODE_ENV = savedEnv.nodeEnv;
  env.LICENCIA_URL = savedEnv.licenciaUrl;
});

function post(path: string, cookie: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function createSession(planId: "free" | "pro" | "enterprise" = "pro") {
  const res = await post("/api/v1/checkout/session", adminCookie, { planId, billingCycle: "annual" });
  expect(res.status).toBe(200);
  return (await res.json()) as { sessionId: string; orderId: string };
}

describe("Checkout & Billing History API", () => {
  it("creates a checkout session and completes an order (BILLING_MODE=simulated)", async () => {
    env.BILLING_MODE = "simulated";

    // 1. Create checkout session
    const sessionRes = await app.request("/api/v1/checkout/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        planId: "pro",
        billingCycle: "annual",
        company: "Acme Infrastructure Inc.",
      }),
    });

    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as any;
    expect(session.sessionId).toMatch(/^cs_/);
    expect(session.planId).toBe("pro");
    expect(session.billingCycle).toBe("annual");
    expect(session.amount).toBe(372); // 31 * 12

    // 2. Complete checkout
    const completeRes = await app.request("/api/v1/checkout/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        paymentMethod: "card",
        paymentReference: "pay_test_billing_123",
        autoActivate: false,
      }),
    });

    expect(completeRes.status).toBe(200);
    const result = (await completeRes.json()) as any;
    expect(result.success).toBe(true);
    expect(result.licenseKey).toMatch(/^LIC-PRO-/);
    expect(result.invoiceNumber).toMatch(/^INV-/);

    // 3. List orders
    const ordersRes = await app.request("/api/v1/checkout/orders", {
      headers: { Cookie: adminCookie },
    });
    expect(ordersRes.status).toBe(200);
    const ordersData = (await ordersRes.json()) as any;
    expect(Array.isArray(ordersData.orders)).toBe(true);

    const createdOrder = ordersData.orders.find((o: any) => o.id === result.orderId);
    expect(createdOrder).toBeDefined();
    expect(createdOrder.status).toBe("paid");
    expect(createdOrder.planId).toBe("pro");
    expect(createdOrder.company).toBe("Acme Infrastructure Inc.");
    expect(createdOrder.invoiceNumber).toBe(result.invoiceNumber);

    // 4. Retrieve single order by ID
    const singleRes = await app.request(`/api/v1/checkout/orders/${result.orderId}`, {
      headers: { Cookie: adminCookie },
    });
    expect(singleRes.status).toBe(200);
    const singleData = (await singleRes.json()) as any;
    expect(singleData.order.id).toBe(result.orderId);
    expect(singleData.order.amount).toBe(372);
    expect(singleData.order.licenseKey).toBe(result.licenseKey);

    // Clean up
    await prisma.order.delete({ where: { id: result.orderId } });
  });

  it("prevents viewers from viewing orders belonging to another user", async () => {
    // Admin creates an order (it stays pending: billing is disabled by default)
    const session = await createSession("free");

    // Viewer attempts to fetch admin's order directly
    const forbiddenRes = await app.request(`/api/v1/checkout/orders/${session.orderId}`, {
      headers: { Cookie: viewerCookie },
    });
    expect(forbiddenRes.status).toBe(403);

    // Clean up
    await prisma.order.delete({ where: { id: session.orderId } });
  });
});

describe("Checkout is admin-only", () => {
  for (const role of ["viewer", "editor"] as const) {
    it(`${role} gets 403 on POST /checkout/session and creates no order`, async () => {
      const cookie = role === "viewer" ? viewerCookie : editorCookie;
      const before = await prisma.order.count();
      const res = await post("/api/v1/checkout/session", cookie, { planId: "enterprise", billingCycle: "annual" });
      expect(res.status).toBe(403);
      expect(await prisma.order.count()).toBe(before);
    });

    it(`${role} gets 403 on POST /checkout/complete, even in simulated mode`, async () => {
      env.BILLING_MODE = "simulated";
      const session = await createSession("enterprise");
      const cookie = role === "viewer" ? viewerCookie : editorCookie;

      const res = await post("/api/v1/checkout/complete", cookie, {
        sessionId: session.sessionId,
        paymentMethod: "card",
        autoActivate: true,
      });
      expect(res.status).toBe(403);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: session.orderId } });
      expect(order.status).toBe("pending");
      expect(order.licenseKey).toBeNull();
      await prisma.order.delete({ where: { id: session.orderId } });
    });
  }
});

describe("BILLING_MODE gate", () => {
  it("disabled (the default): admin completing a checkout gets 501 and the order is not paid", async () => {
    env.BILLING_MODE = "disabled";
    const session = await createSession("pro");

    const res = await post("/api/v1/checkout/complete", adminCookie, {
      sessionId: session.sessionId,
      paymentMethod: "card",
      paymentReference: "pay_forged_by_client",
      autoActivate: true,
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("NOT_IMPLEMENTED");

    const order = await prisma.order.findUniqueOrThrow({ where: { id: session.orderId } });
    expect(order.status).toBe("pending");
    expect(order.licenseKey).toBeNull();
    expect(order.paymentRef).toBeNull();
    await prisma.order.delete({ where: { id: session.orderId } });
  });

  it("simulated: the same request marks the order paid", async () => {
    env.BILLING_MODE = "simulated";
    const session = await createSession("pro");

    const res = await post("/api/v1/checkout/complete", adminCookie, {
      sessionId: session.sessionId,
      paymentMethod: "card",
      autoActivate: false,
    });
    expect(res.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: session.orderId } });
    expect(order.status).toBe("paid");
    expect(order.licenseKey).toMatch(/^LIC-PRO-/);
    await prisma.order.delete({ where: { id: session.orderId } });
  });
});

describe("License activation without a license server", () => {
  it("refuses an unverifiable key in production unless BILLING_MODE=simulated", async () => {
    env.NODE_ENV = "production";
    env.BILLING_MODE = "disabled";
    env.LICENCIA_URL = undefined;
    const before = await prisma.systemLicense.findFirst({ where: { id: 1 } });

    const res = await post("/api/v1/license/activate", adminCookie, { key: "LIC-ENT-AAAA-BBBB-CCCC-DDDD" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toMatch(/License server not configured/);

    // Nothing was granted.
    const after = await prisma.systemLicense.findFirst({ where: { id: 1 } });
    expect(after).toEqual(before);
  });
});
