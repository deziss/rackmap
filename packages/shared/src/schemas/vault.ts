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

/**
 * Re-keying the vault requires proving knowledge of the current passphrase.
 *
 * `forceDestroy` is the deliberate recovery escape hatch for a forgotten passphrase: it
 * mints a brand new data key and permanently orphans every credential encrypted under the
 * old one. It is never implied — the caller has to ask for it.
 */
export const VaultResetInput = z
  .object({
    newPassphrase: z.string().min(8, "New passphrase must be at least 8 characters").max(128),
    currentPassphrase: z.string().min(1).max(128).optional(),
    forceDestroy: z.literal(true).optional(),
  })
  .refine((data) => data.forceDestroy === true || !!data.currentPassphrase, {
    message:
      "The current vault passphrase is required. Set forceDestroy to permanently discard every stored credential instead.",
    path: ["currentPassphrase"],
  });
export type VaultResetInput = z.infer<typeof VaultResetInput>;
