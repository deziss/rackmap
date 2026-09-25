import { z } from "zod";

export const LicenseTierSchema = z.enum(["free", "pro", "enterprise"]);
export type LicenseTier = z.infer<typeof LicenseTierSchema>;

export const LicenseFeatureSchema = z.enum([
  "hardware_discovery",
  "atop_history",
  "remote_os_users",
  "auto_update",
  "multi_channel_alerts",
  "unlimited_servers",
  "remote_cron",
  "runbooks",
  "service_manager",
  "patch_management",
  "drift_detection",
  "access_expiry",
]);
export type LicenseFeature = z.infer<typeof LicenseFeatureSchema>;

export const LicenseStatusResponseSchema = z.object({
  tier: LicenseTierSchema,
  planName: z.string(),
  valid: z.boolean(),
  expiresAt: z.string().nullable(),
  serverCount: z.number(),
  maxServers: z.number(), // -1 = unlimited
  canAddServer: z.boolean(),
  features: z.record(z.string(), z.boolean()),
  licenseKeyMasked: z.string().nullable(),
  isOffline: z.boolean(),
  hardwareId: z.string().optional(),
  message: z.string().optional(),
});
export type LicenseStatusResponse = z.infer<typeof LicenseStatusResponseSchema>;

export const ActivateLicenseRequestSchema = z.object({
  key: z.string().min(1, "License key is required"),
  offlineToken: z.string().optional(),
});
export type ActivateLicenseRequest = z.infer<typeof ActivateLicenseRequestSchema>;


// ─── Checkout & Payment Schemas ───────────────────────────────────────────────

export const CreateCheckoutSessionSchema = z.object({
  planId: z.enum(["free", "pro", "enterprise"]),
  billingCycle: z.enum(["monthly", "annual"]).default("annual"),
  company: z.string().optional(),
});
export type CreateCheckoutSessionInput = z.infer<typeof CreateCheckoutSessionSchema>;

export const CheckoutSessionResponseSchema = z.object({
  sessionId: z.string(),
  planId: z.enum(["free", "pro", "enterprise"]),
  planName: z.string(),
  billingCycle: z.enum(["monthly", "annual"]),
  unitPrice: z.number(),
  amount: z.number(),
  currency: z.string(),
  maxServers: z.number(),
  customerName: z.string(),
  customerEmail: z.string(),
  company: z.string().optional(),
  requiresPayment: z.boolean(),
  orderId: z.string(),
});
export type CheckoutSessionResponse = z.infer<typeof CheckoutSessionResponseSchema>;

export const CompleteCheckoutSchema = z.object({
  sessionId: z.string(),
  paymentMethod: z.enum(["free", "card", "razorpay"]).default("card"),
  paymentReference: z.string().optional(),
  cardNumberLast4: z.string().optional(),
  autoActivate: z.boolean().default(true),
});
export type CompleteCheckoutInput = z.infer<typeof CompleteCheckoutSchema>;

export const CheckoutResultSchema = z.object({
  success: z.boolean(),
  orderId: z.string(),
  invoiceNumber: z.string(),
  licenseKey: z.string(),
  tier: z.enum(["free", "pro", "enterprise"]),
  maxServers: z.number(),
  expiresAt: z.string().nullable(),
  activated: z.boolean(),
  message: z.string(),
});
export type CheckoutResult = z.infer<typeof CheckoutResultSchema>;


export const OrderItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  userId: z.string(),
  planId: z.string(),
  billingCycle: z.string(),
  amount: z.number(),
  currency: z.string(),
  customerName: z.string(),
  customerEmail: z.string(),
  company: z.string().nullable().optional(),
  status: z.string(),
  paymentGateway: z.string().nullable().optional(),
  paymentRef: z.string().nullable().optional(),
  licenseKey: z.string().nullable().optional(),
  invoiceNumber: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
  user: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
    })
    .optional(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderListResponseSchema = z.object({
  orders: z.array(OrderItemSchema),
});
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;
