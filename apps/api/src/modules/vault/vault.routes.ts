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

/**
 * Identify the caller's vault session.
 *
 * Returns the raw Better Auth session cookie value, which vault.service.ts hashes before
 * using it as a key. There is deliberately no shared fallback bucket: a request we cannot
 * attribute to one session gets no vault session at all (requireSession has already proven
 * the caller is authenticated, so this only trips on an unexpected cookie shape).
 */
function getSessionToken(c: any): string | null {
  // Better-auth uses cookie better-auth.session_token (or __Secure-better-auth.session_token)
  const cookies = c.req.header("cookie") || "";
  const match = cookies.match(/better-auth\.session_token=([^;]+)/);
  if (match && match[1]) return match[1];
  return null;
}

function noSessionTokenResponse(c: any) {
  return c.json(
    {
      error: {
        code: "NO_VAULT_SESSION",
        message: "Could not identify the session for this request. Sign in again and retry.",
      },
    },
    401,
  );
}

export const vaultRoutes = new Hono()
  .use(requireSession)

  // GET /vault/status
  .get("/status", async (c) => {
    const token = getSessionToken(c);
    const status = await getVaultStatus(token ?? undefined);
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
      if (!token) return noSessionTokenResponse(c);
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
      if (!token) return noSessionTokenResponse(c);
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
      const { newPassphrase, currentPassphrase, forceDestroy } = c.req.valid("json");
      const token = getSessionToken(c);
      if (!token) return noSessionTokenResponse(c);
      const user = c.get("user");

      // Destroying every stored credential is a separate, explicitly requested act: the
      // schema refuses a reset that neither proves the current passphrase nor asks for it.
      try {
        const result = await resetVault({
          newPassphrase,
          currentPassphrase,
          forceDestroy: forceDestroy === true,
          sessionToken: token,
        });
        await writeAudit({
          ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
          category: "security",
          // The path taken is recorded in `after` — the audit action vocabulary lives in
          // packages/shared/src/constants.ts and has no destructive-reset entry.
          action: "vault.reset",
          entity: "vault",
          after: { mode: result.mode, forceDestroy: forceDestroy === true },
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
    if (!token) return noSessionTokenResponse(c);
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
