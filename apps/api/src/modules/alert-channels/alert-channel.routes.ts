import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  AlertChannelCreateInput,
  AlertChannelToggleInput,
  AlertChannelUpdateInput,
  AlertDeliveryListQuery,
  type AlertChannelDto,
} from "@inv/shared";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { callerIdentity, rateLimit } from "../../middleware/rate-limit.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  listDeliveries,
  testChannel,
  updateChannel,
} from "../../services/alert-channel.service.js";

/**
 * Alert channels (Settings → Alerts). Admin manages, editor may read.
 *
 * Every route carries its own requirePermission — guards are per route here,
 * not per router — and nothing returned ever includes a secret: URLs, routing
 * keys, bot tokens and HMAC secrets are write-only (see alert-channel.service).
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * Test sends hit a third-party API synchronously on the operator's click.
 * 10 per 5 minutes per user, shared by the saved-channel test, the draft test
 * and the per-server test alert, so the three cannot be combined to spam a
 * Slack channel or burn a PagerDuty rate limit.
 */
export const alertTestRateLimit = rateLimit({
  windowMs: 5 * 60_000,
  max: 10,
  key: (c) => `${callerIdentity(c)}|alert-test`,
  message: "Too many test alerts. Try again in a few minutes.",
});

/** What the audit log records about a channel: never the secret, only its masked hint. */
function auditView(ch: AlertChannelDto) {
  return {
    name: ch.name,
    type: ch.type,
    enabled: ch.enabled,
    managedBy: ch.managedBy,
    events: ch.events,
    filters: ch.filters,
    secretHint: ch.secretHint,
    config: ch.config,
  };
}

export const alertChannelRoutes = new Hono()
  .use(requireSession)

  // GET /alert-channels — list (masked)
  .get("/", requirePermission({ alertChannel: ["read"] }), async (c) => {
    return c.json(await listChannels());
  })

  // POST /alert-channels — create
  .post("/", requirePermission({ alertChannel: ["manage"] }), zValidator("json", AlertChannelCreateInput), async (c) => {
    const input = c.req.valid("json");
    const user = c.get("user");
    const created = await createChannel(input, user?.id ?? null);
    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "data",
      action: "alert_channel.create",
      entity: "AlertChannel",
      entityId: String(created.id),
      after: auditView(created),
    });
    return c.json(created, 201);
  })

  // POST /alert-channels/test — send a test through an unsaved draft
  .post(
    "/test",
    requirePermission({ alertChannel: ["manage"] }),
    alertTestRateLimit,
    zValidator("json", AlertChannelCreateInput),
    async (c) => {
      const input = c.req.valid("json");
      const result = await testChannel(input);
      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "notification",
        action: "alert_channel.test",
        entity: "AlertChannel",
        after: { draft: true, type: input.type, name: input.name, ok: result.ok, statusCode: result.statusCode },
      });
      return c.json(result);
    },
  )

  // GET /alert-channels/:id
  .get("/:id", requirePermission({ alertChannel: ["read"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await getChannel(id));
  })

  // PATCH /alert-channels/:id — omitted secret fields keep the stored secret
  .patch(
    "/:id",
    requirePermission({ alertChannel: ["manage"] }),
    zValidator("param", idParam),
    zValidator("json", z.union([AlertChannelUpdateInput, AlertChannelToggleInput])),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const { before, after } = await updateChannel(id, input);
      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "data",
        action: "alert_channel.update",
        entity: "AlertChannel",
        entityId: String(id),
        before: auditView(before),
        after: {
          ...auditView(after),
          // Record THAT a secret changed, never what it is.
          secretChanged: before.secretHint !== after.secretHint || before.hasHmacSecret !== after.hasHmacSecret,
        },
      });
      return c.json(after);
    },
  )

  // DELETE /alert-channels/:id — env-managed channels answer 409
  .delete("/:id", requirePermission({ alertChannel: ["manage"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const removed = await deleteChannel(id);
    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "data",
      action: "alert_channel.delete",
      entity: "AlertChannel",
      entityId: String(id),
      before: auditView(removed),
    });
    return c.json({ ok: true });
  })

  // POST /alert-channels/:id/test — synchronous test send, logged as a `test` delivery
  .post(
    "/:id/test",
    requirePermission({ alertChannel: ["manage"] }),
    alertTestRateLimit,
    zValidator("param", idParam),
    async (c) => {
      const { id } = c.req.valid("param");
      const result = await testChannel(id);
      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "notification",
        action: "alert_channel.test",
        entity: "AlertChannel",
        entityId: String(id),
        after: { ok: result.ok, statusCode: result.statusCode, deliveryId: result.deliveryId },
      });
      return c.json(result);
    },
  )

  // GET /alert-channels/:id/deliveries?status&cursor — delivery log
  .get(
    "/:id/deliveries",
    requirePermission({ alertChannel: ["manage"] }),
    zValidator("param", idParam),
    zValidator("query", AlertDeliveryListQuery),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await listDeliveries(id, c.req.valid("query")));
    },
  );
