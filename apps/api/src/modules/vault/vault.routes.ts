import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { can } from "../../lib/permissions.js";
import { writeAudit } from "../../lib/audit.js";
import { VaultInitInput, VaultUnlockInput, VaultResetInput } from "@inv/shared";
import {
  getVaultStatus,
  initVault,
  unlockVault,
  lockVault,
  resetVault,
  unlockVaultGlobal,
  lockVaultGlobal,
} from "../../services/vault.service.js";

function getSessionToken(c: any): string {
  // Better-auth uses cookie better-auth.session_token
  const cookies = c.req.header("cookie") || "";
  const match = cookies.match(/better-auth\.session_token=([^;]+)/);
  if (match) return match[1];
  return c.get("session")?.token || "anonymous";
}

export const vaultRoutes = new Hono()
  .use(requireSession)

  // GET /vault/status
  .get("/status", async (c) => {
    const token = getSessionToken(c);
    const status = await getVaultStatus(token);
    return c.json(status);
  })

  // POST /vault/init (admin only)
  .post(
    "/init",
    requirePermission({ vault: ["init"] }),
    zValidator("json", VaultInitInput),
    async (c) => {
      const { passphrase } = c.req.valid("json");
      const token = getSessionToken(c);
      const user = c.get("user");
      try {
        const result = await initVault(passphrase, token);
        await writeAudit({
          ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
          category: "security",
          action: "vault.init",
          entity: "vault",
        });
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: { code: "VAULT_ERROR", message: err.message } }, 400);
      }
    },
  )

  // POST /vault/unlock
  .post(
    "/unlock",
    requirePermission({ vault: ["unlock"] }),
    zValidator("json", VaultUnlockInput),
    async (c) => {
      const { passphrase } = c.req.valid("json");
      const token = getSessionToken(c);
      const user = c.get("user");
      try {
        const result = await unlockVault(passphrase, token);
        await writeAudit({
          ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
          category: "security",
          action: "vault.unlock",
          entity: "vault",
        });
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: { code: "INVALID_PASSPHRASE", message: err.message } }, 401);
      }
    },
  )

  // POST /vault/unlock-global (admin only)
  .post(
    "/unlock-global",
    requirePermission({ vault: ["unlockGlobal"] }),
    zValidator("json", z.object({ passphrase: z.string().min(1), persistToEnv: z.boolean().optional() })),
    async (c) => {
      const { passphrase, persistToEnv } = c.req.valid("json");
      const user = c.get("user");

      // Persisting writes the master passphrase to .env in plaintext, so it
      // needs its own permission rather than riding along with the unlock.
      if (persistToEnv && !can(user?.role ?? "viewer", "vault", "persist")) {
        return c.json(
          { error: { code: "FORBIDDEN", message: "Not permitted to persist the vault passphrase to disk" } },
          403,
        );
      }

      try {
        const result = await unlockVaultGlobal(passphrase, !!persistToEnv);
        await writeAudit({
          ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
          category: "security",
          action: "vault.unlock_global",
          entity: "vault",
          after: { persistedToEnv: !!persistToEnv },
        });
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: { code: "INVALID_PASSPHRASE", message: err.message } }, 401);
      }
    },
  )

  // POST /vault/lock-global (admin only)
  .post(
    "/lock-global",
    requirePermission({ vault: ["unlockGlobal"] }),
    async (c) => {
      const user = c.get("user");
      const result = lockVaultGlobal();
      await writeAudit({
        ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
        category: "security",
        action: "vault.lock_global",
        entity: "vault",
      });
      return c.json(result);
    },
  )

  // POST /vault/reset (admin only)
  .post(
    "/reset",
    requirePermission({ vault: ["reset"] }),
    zValidator("json", VaultResetInput),
    async (c) => {
      const { passphrase } = c.req.valid("json");
      const token = getSessionToken(c);
      const user = c.get("user");
      try {
        const result = await resetVault(passphrase, token);
        await writeAudit({
          ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
          category: "security",
          action: "vault.reset",
          entity: "vault",
        });
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: { code: "VAULT_ERROR", message: err.message } }, 400);
      }
    },
  )

  // POST /vault/lock
  .post("/lock", async (c) => {
    const token = getSessionToken(c);
    const user = c.get("user");
    const result = lockVault(token);
    await writeAudit({
      ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
      category: "security",
      action: "vault.lock",
      entity: "vault",
    });
    return c.json(result);
  });
