import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import { notFound } from "../../lib/errors.js";

/**
 * Review and manage pinned SSH host keys.
 *
 * Without this, the documented migration to `SSH_HOST_POLICY=tofu` is not
 * practical: an operator has to read the table with `sqlite3` to see what was
 * pinned, and every legitimate rebuild or reimage becomes a shell-into-the-
 * database event to clear the stale key.
 *
 * Deleting a pin is a security-relevant action — the next connection to that
 * endpoint will trust whatever answers — so it is admin-only and audited.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  /** Filter to one server's endpoints. */
  serverId: z.coerce.number().int().positive().optional(),
  /** Find every endpoint presenting a given key — catches one impostor answering for many addresses. */
  fingerprint: z.string().trim().min(1).max(128).optional(),
});

export const sshHostKeyRoutes = new Hono()
  .use(requireSession)

  // GET /api/v1/ssh-host-keys — review what has been pinned
  .get("/", requirePermission({ server: ["update"] }), zValidator("query", listQuery), async (c) => {
    const { serverId, fingerprint } = c.req.valid("query");

    const keys = await prisma.sshHostKey.findMany({
      where: {
        ...(serverId ? { serverId } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      },
      orderBy: [{ firstSeenAt: "asc" }],
    });

    // Surface endpoints sharing a fingerprint: legitimate for a cluster behind
    // one image, suspicious otherwise. Cheap to compute, and it is the question
    // an operator actually asks when reviewing the store.
    const seen = new Map<string, number>();
    for (const k of keys) seen.set(k.fingerprint, (seen.get(k.fingerprint) ?? 0) + 1);

    return c.json({
      items: keys.map((k) => ({
        id: k.id,
        host: k.host,
        port: k.port,
        keyType: k.keyType,
        fingerprint: k.fingerprint,
        firstSeenAt: k.firstSeenAt,
        lastSeenAt: k.lastSeenAt,
        serverId: k.serverId,
        sharedWithOtherEndpoints: (seen.get(k.fingerprint) ?? 0) > 1,
      })),
      total: keys.length,
    });
  })

  // DELETE /api/v1/ssh-host-keys/:id — forget a pin so the next connection re-pins
  .delete("/:id", requirePermission({ server: ["delete"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");

    const existing = await prisma.sshHostKey.findUnique({ where: { id } });
    if (!existing) throw notFound("SshHostKey");

    await prisma.sshHostKey.delete({ where: { id } });

    // Record the fingerprint being forgotten: after this, the next connection
    // to that endpoint trusts whatever key answers, so the old value is the
    // thing an investigator will want.
    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "security",
      action: "ssh_host_key.forget",
      entity: "SshHostKey",
      entityId: String(id),
      before: {
        host: existing.host,
        port: existing.port,
        keyType: existing.keyType,
        fingerprint: existing.fingerprint,
        firstSeenAt: existing.firstSeenAt,
      },
    });

    return c.json({ ok: true });
  });
