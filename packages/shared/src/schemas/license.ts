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
