import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { notFound } from "../../lib/errors.js";

const apiKeyRoutes = new Hono();

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
    select: { id: true, name: true, start: true, createdAt: true, expiresAt: true, lastRefillAt: true, requestCount: true },
  });
  return c.json(keys);
});

// POST /api-keys — create
apiKeyRoutes.post("/", requireSession, async (c) => {
  const user = c.get("user");
  const body = await c.req.json() as { name?: string };
  const name = body.name?.trim() || "My API Key";

  const { raw, hash, start } = generateKey();
  const id = randomBytes(12).toString("hex");

  await prisma.apiKey.create({
    data: { id, name, key: hash, start, userId: user.id },
  });

  // Return raw key ONCE — caller must store it
  return c.json({ id, name, start, key: raw }, 201);
});

// DELETE /api-keys/:id — soft delete (own key only)
apiKeyRoutes.delete("/:id", requireSession, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing || existing.userId !== user.id || existing.deletedAt) throw notFound("ApiKey");
  await prisma.apiKey.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
  return c.json({ ok: true });
});

export { apiKeyRoutes };

/** Middleware: allow Bearer API-key auth in addition to session cookies. */
export async function apiKeyAuth(c: Parameters<typeof requireSession>[0], next: Parameters<typeof requireSession>[1]) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer sk_")) {
    const raw = authHeader.slice(7);
    const hash = createHash("sha256").update(raw).digest("hex");
    const key = await prisma.apiKey.findFirst({
      where: { key: hash, enabled: true, deletedAt: null },
      include: { user: { select: { id: true, email: true, name: true, role: true, banned: true } } },
    });
    if (key && !key.user.banned) {
      // Increment request count
      await prisma.apiKey.update({ where: { id: key.id }, data: { requestCount: { increment: 1 }, lastRefillAt: new Date() } });
      c.set("user", { id: key.user.id, email: key.user.email, name: key.user.name, role: (key.user as { role?: string | null }).role ?? "viewer" });
      return next();
    }
  }
  return requireSession(c, next);
}
