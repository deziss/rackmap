import { z } from "zod";

export const SshKeyInfo = z.object({
  id: z.string(),
  name: z.string(),
  keyType: z.enum(["ed25519", "rsa", "ecdsa", "unknown"]),
  fingerprint: z.string(),
  publicKey: z.string().optional(),
  source: z.enum(["host", "custom"]),
  /** Server-side only. Never populated in API responses — an on-disk private key path is not something clients need. */
  path: z.string().optional(),
  isDefault: z.boolean().default(false),
  boundServers: z.array(
    z.object({
      id: z.number(),
      hostname: z.string(),
      ip: z.string(),
    })
  ).default([]),
});
export type SshKeyInfo = z.infer<typeof SshKeyInfo>;

export const AddSshKeyInput = z.object({
  name: z.string().min(1).max(100),
  privateKey: z.string().min(20),
  passphrase: z.string().optional(),
  customPath: z.string().optional(),
});
export type AddSshKeyInput = z.infer<typeof AddSshKeyInput>;

export const SshKeyTestResult = z.object({
  success: z.boolean(),
  latencyMs: z.number().optional(),
  message: z.string(),
  authMethodUsed: z.enum(["key", "password"]).optional(),
});
export type SshKeyTestResult = z.infer<typeof SshKeyTestResult>;
