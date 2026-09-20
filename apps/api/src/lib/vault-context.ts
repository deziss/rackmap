import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Next } from "hono";

/**
 * Carries the caller's vault session token for the duration of a request.
 *
 * Vault-wrapped credentials (`v2.` blobs) can only be opened with the DEK of an
 * unlocked session. `decryptPasswordWithVault` accepts that token explicitly,
 * and the reveal-password path passes it — but SSH does not: `connectToServer`
 * is called from eighteen places, including the scheduler and the alert sweep,
 * which have no request and no operator at all.
 *
 * Threading a token through every one of those signatures would put a
 * request-scoped concern into background code paths that genuinely do not have
 * one. Instead the token rides along implicitly here: request-driven work finds
 * it, background work finds nothing and falls back to the system session
 * (VAULT_PASSPHRASE or an admin's global unlock), which is exactly the intended
 * behaviour for unattended jobs.
 */
const vaultSessionStorage = new AsyncLocalStorage<string | undefined>();

/** The vault session token for the in-flight request, if there is one. */
export function currentVaultSessionToken(): string | undefined {
  return vaultSessionStorage.getStore();
}

/** Extract the Better Auth session token from the request cookies. */
function readSessionToken(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/better-auth\.session_token=([^;]+)/);
  return match?.[1];
}

/**
 * Middleware: run the rest of the request inside a context carrying the
 * caller's vault session token.
 */
export async function withVaultSession(c: Context, next: Next) {
  return vaultSessionStorage.run(readSessionToken(c), next);
}
