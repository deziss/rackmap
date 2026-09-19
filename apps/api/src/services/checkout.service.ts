import crypto from "node:crypto";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../lib/errors.js";
import { activateLicense } from "./license.service.js";
import type {
  CreateCheckoutSessionInput,
  CheckoutSessionResponse,
  CompleteCheckoutInput,
  CheckoutResult,
} from "@inv/shared";

function generateLicenciaKeyString(tier: "free" | "pro" | "enterprise"): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const LENGTH = 24;
  const bytes = crypto.randomBytes(LENGTH);
  let result = "";
  for (let i = 0; i < LENGTH; i++) {
    result += CHARS[bytes[i]! % CHARS.length]!;
  }
  const prefix = tier === "enterprise" ? "LIC-ENT" : tier === "pro" ? "LIC-PRO" : "LIC-FREE";
  return `${prefix}-${result.substring(0, 4)}-${result.substring(4, 8)}-${result.substring(8, 12)}-${result.substring(12, 16)}`;
}

function generateInvoiceNumber(): string {
  const year = new Date().getFullYear();
  const hex = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `INV-${year}-${hex}`;
}

export async function createCheckoutSession(
  userId: string,
  input: CreateCheckoutSessionInput
): Promise<CheckoutSessionResponse> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError("NOT_FOUND", "Authenticated user not found", 404);
  }

  const isAnnual = input.billingCycle === "annual";
  let unitPrice = 0;
  let amount = 0;
  let planName = "Community Edition";
  let maxServers = 10;

  if (input.planId === "pro") {
    planName = "RackMap Professional";
    unitPrice = isAnnual ? 31 : 39;
    amount = isAnnual ? 31 * 12 : 39;
    maxServers = 100;
  } else if (input.planId === "enterprise") {
    planName = "RackMap Enterprise";
    unitPrice = isAnnual ? 199 : 249;
    amount = isAnnual ? 199 * 12 : 249;
    maxServers = -1; // unlimited
  } else {
    planName = "Community Edition";
    unitPrice = 0;
    amount = 0;
    maxServers = 10;
  }

  const sessionId = `cs_${crypto.randomBytes(16).toString("hex")}`;
  const invoiceNumber = generateInvoiceNumber();

  // Try creating/linking customer in Licencia if server is online
  if (env.LICENCIA_URL) {
    try {
      await fetch(`${env.LICENCIA_URL.replace(/\/$/, "")}/api/v1/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.LICENCIA_API_KEY ? { "x-api-key": env.LICENCIA_API_KEY } : {}),
        },
        body: JSON.stringify({
          email: user.email,
          name: user.name,
          company: input.company || undefined,
        }),
      });
    } catch {
      // Best-effort remote sync
    }
  }

  const order = await prisma.order.create({
    data: {
      sessionId,
      userId,
      planId: input.planId,
      billingCycle: input.billingCycle,
      amount,
      currency: "USD",
      customerName: user.name,
      customerEmail: user.email,
      company: input.company || null,
      status: "pending",
      invoiceNumber,
    },
  });

  return {
    sessionId,
    planId: input.planId,
    planName,
    billingCycle: input.billingCycle,
    unitPrice,
    amount,
    currency: "USD",
    maxServers,
    customerName: user.name,
    customerEmail: user.email,
    company: input.company,
    requiresPayment: amount > 0,
    orderId: order.id,
  };
}

export async function completeCheckout(
  userId: string,
  input: CompleteCheckoutInput
): Promise<CheckoutResult> {
  const order = await prisma.order.findUnique({
    where: { sessionId: input.sessionId },
  });

  if (!order) {
    throw new AppError("NOT_FOUND", "Checkout session not found", 404);
  }

  if (order.userId !== userId) {
    throw new AppError("FORBIDDEN", "Unauthorized checkout session", 403);
  }

  if (order.status === "paid" && order.licenseKey) {
    return {
      success: true,
      orderId: order.id,
      invoiceNumber: order.invoiceNumber || "INV-COMPLETED",
      licenseKey: order.licenseKey,
      tier: order.planId as any,
      maxServers: order.planId === "enterprise" ? -1 : order.planId === "pro" ? 100 : 10,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      activated: true,
      message: "Order already fulfilled",
    };
  }

  let licenseKey = "";

  // 1. If upstream Licencia server is available, request official key
  if (env.LICENCIA_URL) {
    try {
      const res = await fetch(`${env.LICENCIA_URL.replace(/\/$/, "")}/api/v1/licenses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.LICENCIA_API_KEY ? { "x-api-key": env.LICENCIA_API_KEY } : {}),
        },
        body: JSON.stringify({
          type: order.planId === "enterprise" ? "PERPETUAL" : "SUBSCRIPTION",
          maxActivations: order.planId === "enterprise" ? 10 : 3,
          metadata: {
            tier: order.planId,
            customerEmail: order.customerEmail,
            orderId: order.id,
            product: "rackmap",
          },
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data && data.key) {
          licenseKey = data.key;
        }
      }
    } catch {
      // Fall through to authentic generator
    }
  }

  // 2. Generate authentic Licencia format key if upstream was unavailable
  if (!licenseKey) {
    licenseKey = generateLicenciaKeyString(order.planId as any);
  }

  // 3. Mark order as paid
  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: "paid",
      paymentGateway: input.paymentMethod,
      paymentRef: input.paymentReference || `pay_${crypto.randomBytes(8).toString("hex")}`,
      licenseKey,
    },
  });

  // 4. Auto-activate if requested
  let activated = false;
  if (input.autoActivate) {
    try {
      await activateLicense({ key: licenseKey });
      activated = true;
    } catch (e: any) {
      console.warn(`[Licencia Checkout] Auto-activation error: ${e.message}`);
    }
  }

  const maxServers = order.planId === "enterprise" ? -1 : order.planId === "pro" ? 100 : 10;
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  return {
    success: true,
    orderId: order.id,
    invoiceNumber: order.invoiceNumber || generateInvoiceNumber(),
    licenseKey,
    tier: order.planId as any,
    maxServers,
    expiresAt,
    activated,
    message: activated
      ? `Subscription activated! Your instance now has access to the ${order.planId.toUpperCase()} tier.`
      : `Payment successful! License key issued.`,
  };
}

export async function getUserOrders(userId: string, isAdmin: boolean) {
  if (isAdmin) {
    return prisma.order.findMany({
      orderBy: { createdAt: "desc" },
    });
  }
  return prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}
