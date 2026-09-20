import { Hono } from "hono";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { notFound } from "../../lib/errors.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";

const apiKeyRoutes = new Hono();

/** Roles a key may be scoped to, ordered least to most privileged. */
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };

const CreateApiKeyInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  /**
   * Role ceiling for the key. Defaults to "viewer" — a key minted without
   * thinking about it should be the least dangerous thing, not a copy of the
   * creator's privileges.
   */
  scopeRole: z.enum(["viewer", "editor", "admin"]).optional(),
  /** Days until the key stops working. Keys that never expire are a liability. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

function generateKey(): { raw: string; hash: string; start: string } {
  const raw = "sk_" + randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  const start = raw.slice(0, 10);
  return { raw, hash, start };
}

// GET /api-keys — list own keys (never return key value)
apiKeyRoutes.get("/", requireSession, async (c) => {
  const user = c.get("user");
  const keys = await prisma.apiKey.findMany({
    where: { userId: user.id, deletedAt: null, enabled: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, start: true, scopeRole: true, createdAt: true, expiresAt: true, lastRefillAt: true, requestCount: true },
  });
  return c.json(keys);
});

// POST /api-keys — create
apiKeyRoutes.post("/", requireSession, async (c) => {
  const user = c.get("user");

  let raw_body: unknown = {};
  try {
    raw_body = await c.req.json();
  } catch {
    // an empty body is fine — everything is optional
  }
  const parsed = CreateApiKeyInput.safeParse(raw_body ?? {});
  if (!parsed.success) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid request body" } }, 400);
  }

  const name = parsed.data.name ?? "My API Key";
  const scopeRole = parsed.data.scopeRole ?? "viewer";

  // A key must never be able to do more than the person minting it.
  const ownerRank = ROLE_RANK[user.role] ?? 0;
  const requestedRank = ROLE_RANK[scopeRole] ?? 0;
  if (requestedRank > ownerRank) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Cannot create a key more privileged than your own role" } },
      403,
    );
  }

  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const { raw, hash, start } = generateKey();
  const id = randomBytes(12).toString("hex");

  await prisma.apiKey.create({
    data: { id, name, key: hash, start, userId: user.id, scopeRole, expiresAt },
  });

  await writeAuditDirect({
    ctx: getAuditCtx(c),
    category: "security",
    action: "api_key.create",
    entity: "ApiKey",
    entityId: id,
    after: { name, start, scopeRole, expiresAt },
  });

  // Return raw key ONCE — caller must store it
  return c.json({ id, name, start, scopeRole, expiresAt, key: raw }, 201);
});

// DELETE /api-keys/:id — soft delete (own key only)
apiKeyRoutes.delete("/:id", requireSession, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing || existing.userId !== user.id || existing.deletedAt) throw notFound("ApiKey");
  await prisma.apiKey.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
  await writeAuditDirect({
    ctx: getAuditCtx(c),
    category: "security",
    action: "api_key.revoke",
    entity: "ApiKey",
    entityId: id,
    before: { name: existing.name, start: existing.start },
  });
  return c.json({ ok: true });
});

export { apiKeyRoutes };

/**
 * Optionally authenticate a request from `Authorization: Bearer sk_...`.
 *
 * Mounted globally on `/api/v1/*` in app.ts, ahead of the route groups. It is
 * deliberately NOT an enforcer:
 *   - no API key present  -> next(), and the route's own `requireSession`
 *                            handles cookie auth (or the route stays public)
 *   - valid API key       -> sets `user` on the context; `requireSession` sees
 *                            it is already populated and short-circuits
 *   - malformed/expired   -> 401, because a caller that presented a credential
 *                            deserves to be told it was rejected rather than
 *                            falling through to an anonymous 401 later
 *
 * Composing this way means machine clients work without editing every route
 * module, and browser traffic is completely unaffected.
 *
 * A key is accepted only when it is enabled, not soft-deleted, not expired, and
 * owned by a user who is not banned. Its effective role is the lower of the
 * key's `scopeRole` and the owner's current role, so demoting a user
 * immediately demotes their keys.
 */
export async function apiKeyAuth(c: Parameters<typeof requireSession>[0], next: Parameters<typeof requireSession>[1]) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer sk_")) {
    return next();
  }

  const raw = authHeader.slice("Bearer ".length).trim();
  const hash = createHash("sha256").update(raw).digest("hex");

  // `key` is @unique and stores the hash, so this is an indexed point lookup.
  const key = await prisma.apiKey.findUnique({
    where: { key: hash },
    include: { user: { select: { id: true, email: true, name: true, role: true, banned: true } } },
  });

  const unauthorized = () =>
    c.json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired API key" } }, 401);

  if (!key || !key.enabled || key.deletedAt) return unauthorized();
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return unauthorized();
  if (!key.user || key.user.banned) return unauthorized();

  // The key's scope is a ceiling, never a promotion: take the lower of the two
  // so a later role downgrade on the user applies to existing keys too.
  const ownerRole = key.user.role ?? "viewer";
  const scoped = key.scopeRole ?? ownerRole;
  const effectiveRole =
    (ROLE_RANK[scoped] ?? 0) <= (ROLE_RANK[ownerRole] ?? 0) ? scoped : ownerRole;

  // Usage accounting is best-effort: a failed counter update must not fail the
  // request, and it is deliberately not awaited on the hot path.
  void prisma.apiKey
    .update({ where: { id: key.id }, data: { requestCount: { increment: 1 }, lastRefillAt: new Date() } })
    .catch(() => {
      /* counter drift is acceptable; losing the request is not */
    });

  c.set("user", {
    id: key.user.id,
    email: key.user.email,
    name: key.user.name,
    role: effectiveRole,
  });
  return next();
}
