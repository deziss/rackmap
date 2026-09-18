import { z } from "zod";

export const VaultStatusResponse = z.object({
  isInitialized: z.boolean(),
  isUnlocked: z.boolean(),
  isGlobalUnlocked: z.boolean().optional(),
  autoLockMinutes: z.number(),
  expiresAt: z.string().nullable(),
  isEnvUnlocked: z.boolean().optional(),
});
export type VaultStatusResponse = z.infer<typeof VaultStatusResponse>;

export const VaultInitInput = z.object({
  passphrase: z.string().min(8, "Passphrase must be at least 8 characters").max(128),
});
export type VaultInitInput = z.infer<typeof VaultInitInput>;

export const VaultUnlockInput = z.object({
  passphrase: z.string().min(1, "Passphrase is required").max(128),
});
export type VaultUnlockInput = z.infer<typeof VaultUnlockInput>;

export const VaultResetInput = z.object({
  passphrase: z.string().min(8, "Passphrase must be at least 8 characters").max(128),
});
export type VaultResetInput = z.infer<typeof VaultResetInput>;
