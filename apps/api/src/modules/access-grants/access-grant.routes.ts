import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  AccessGrantExtendInput,
  AccessGrantListQuery,
  TemporaryKeyCreateInput,
  TemporaryUserCreateInput,
  type AccessGrantListResponse,
  type AccessGrantMutationResponse,
} from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx } from "../../lib/audit.js";
import { can } from "../../lib/permissions.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import { grantsPrivilegedAccess, PRIVILEGED_GRANT_MESSAGE } from "../../services/os-user.service.js";
import {
  accessGrantErrorToHttp,
  createTemporaryUser,
  extendGrant,
  grantPermissions,
  grantTemporaryKey,
  listGrants,
  loadGrant,
  revokeGrant,
  toAccessGrantDto,
  type AccessGrantActor,
  type AccessGrantCtx,
} from "../../services/access-grant.service.js";

/**
 * Time-boxed access grants — mounted at /api/v1/access-grants.
 *
 * editor: read + create (and extend / revoke their OWN grants) · admin: all.
 * A temporary account with sudo or a privileged group, and a key for root, also
 * need server:sudo; that check runs on the body alone, before the license check
 * and before any SSH, like the OS-users routes. Revoking and listing are never
 * license-gated: access granted under Pro must stay revocable after a downgrade.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

function actorOf(c: Context): AccessGrantActor {
  const user = c.get("user");
  return { id: user.id, role: user.role };
}

function grantCtx(c: Context): AccessGrantCtx {
  const actor = actorOf(c);
  return {
    actor,
    audit: getAuditCtx(c),
    sshPassword: c.req.header("x-ssh-password") || undefined,
    allowPrivileged: can(actor.role, "server", "sudo"),
  };
}

function fail(c: Context, err: unknown, fallbackCode: string) {
  const { status, code, message } = accessGrantErrorToHttp(err, fallbackCode);
  if (status === 500) console.error(`[access-grants] ${fallbackCode}:`, err);
  return c.json({ error: { code, message } }, status);
}

export const accessGrantRoutes = new Hono()
  .use(requireSession)

  // GET /access-grants?serverId&status&kind
  .get("/", requirePermission({ accessGrant: ["read"] }), zValidator("query", AccessGrantListQuery), async (c) => {
    const actor = actorOf(c);
    const rows = await listGrants(c.req.valid("query"));
    const now = new Date();
    return c.json({ items: rows.map((g) => toAccessGrantDto(g, actor, now)) } satisfies AccessGrantListResponse);
  })

  // GET /access-grants/:id
  .get("/:id", requirePermission({ accessGrant: ["read"] }), zValidator("param", idParam), async (c) => {
    const grant = await loadGrant(c.req.valid("param").id);
    return c.json({ grant: toAccessGrantDto(grant, actorOf(c)) });
  })

  // POST /access-grants/users — create a temporary OS account
  .post(
    "/users",
    requirePermission({ accessGrant: ["create"], server: ["osUsers"] }),
    zValidator("json", TemporaryUserCreateInput),
    async (c) => {
      const input = c.req.valid("json");
      const ctx = grantCtx(c);
      if (!ctx.allowPrivileged && grantsPrivilegedAccess(input)) {
        return c.json({ error: { code: "FORBIDDEN", message: PRIVILEGED_GRANT_MESSAGE } }, 403);
      }
      await assertFeatureEnabled("access_expiry");
      try {
        const { grant, warnings } = await createTemporaryUser(input, ctx);
        return c.json({ grant: toAccessGrantDto(grant, ctx.actor), warnings } satisfies AccessGrantMutationResponse, 201);
      } catch (err) {
        return fail(c, err, "ACCESS_GRANT_CREATE_ERROR");
      }
    },
  )

  // POST /access-grants/keys — add a temporary SSH key to an existing account
  .post("/keys", requirePermission({ accessGrant: ["create"] }), zValidator("json", TemporaryKeyCreateInput), async (c) => {
    const input = c.req.valid("json");
    const ctx = grantCtx(c);
    // uid-0 aliases and members of privileged groups are refused on the host.
    if (!ctx.allowPrivileged && input.username === "root") {
      return c.json({ error: { code: "FORBIDDEN", message: "Granting a key for root requires the server:sudo permission" } }, 403);
    }
    await assertFeatureEnabled("access_expiry");
    try {
      const { grant, warnings } = await grantTemporaryKey(input, ctx);
      return c.json({ grant: toAccessGrantDto(grant, ctx.actor), warnings } satisfies AccessGrantMutationResponse, 201);
    } catch (err) {
      return fail(c, err, "ACCESS_GRANT_CREATE_ERROR");
    }
  })

  // POST /access-grants/:id/extend — creator or admin
  .post(
    "/:id/extend",
    requirePermission({ accessGrant: ["create"] }),
    zValidator("param", idParam),
    zValidator("json", AccessGrantExtendInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const ctx = grantCtx(c);
      const current = await loadGrant(id);
      const isCreator = !!current.createdById && current.createdById === ctx.actor.id;
      if (!isCreator && !can(ctx.actor.role, "accessGrant", "revoke")) {
        return c.json({ error: { code: "FORBIDDEN", message: "Only the grant's creator or an administrator can extend it" } }, 403);
      }
      await assertFeatureEnabled("access_expiry");
      try {
        const { grant, warnings } = await extendGrant(id, c.req.valid("json").expiresAt, ctx);
        return c.json({ grant: toAccessGrantDto(grant, ctx.actor), warnings } satisfies AccessGrantMutationResponse);
      } catch (err) {
        return fail(c, err, "ACCESS_GRANT_EXTEND_ERROR");
      }
    },
  )

  // POST /access-grants/:id/revoke — accessGrant:revoke, or the grant's creator
  .post("/:id/revoke", requirePermission({ accessGrant: ["read"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const ctx = grantCtx(c);
    const current = await loadGrant(id);
    const perms = grantPermissions(current, ctx.actor);
    const isCreator = !!current.createdById && current.createdById === ctx.actor.id;
    const allowed = can(ctx.actor.role, "accessGrant", "revoke") || (isCreator && can(ctx.actor.role, "accessGrant", "create"));
    if (!allowed) {
      return c.json({ error: { code: "FORBIDDEN", message: "Only the grant's creator or an administrator can revoke it" } }, 403);
    }
    if (!perms.canRevoke) {
      return c.json({ error: { code: "CONFLICT", message: `The grant is ${current.status.replace("_", " ")} and cannot be revoked` } }, 409);
    }
    const result = await revokeGrant(id, { actor: ctx.actor, audit: ctx.audit, sshPassword: ctx.sshPassword });
    if (result.outcome === "skipped") {
      return c.json({ error: { code: "CONFLICT", message: "The grant is already being revoked or changed" } }, 409);
    }
    if (result.outcome === "failed") {
      const { status, code, message } = accessGrantErrorToHttp(result.error, "ACCESS_GRANT_REVOKE_ERROR");
      return c.json(
        { error: { code, message, details: { grant: toAccessGrantDto(result.grant, ctx.actor) } } },
        status,
      );
    }
    return c.json({ grant: toAccessGrantDto(result.grant, ctx.actor), warnings: [] } satisfies AccessGrantMutationResponse);
  });
