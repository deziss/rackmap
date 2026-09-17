import { z } from "zod";

export const AutoUpdateStatus = z.object({
  installed: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  serviceStatus: z.string(),
  packageManager: z.enum(["apt", "dnf", "yum", "other"]),
  updatePackageLists: z.boolean().default(false),
  unattendedUpgrade: z.boolean().default(false),
  lastLogSnippet: z.string().nullable().optional(),
});
export type AutoUpdateStatus = z.infer<typeof AutoUpdateStatus>;

export const AutoUpdateActionInput = z.object({
  action: z.enum(["enable", "disable", "remove"]),
});
export type AutoUpdateActionInput = z.infer<typeof AutoUpdateActionInput>;
