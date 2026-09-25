import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Prisma } from "@prisma/client";
import {
  HeartbeatCreateInput,
  HeartbeatListQuery,
  HeartbeatPingsQuery,
  HeartbeatRotateInput,
  HeartbeatUpdateInput,
  type HeartbeatCreatedResponse,
  type HeartbeatDetailResponse,
  type HeartbeatListResponse,
  type HeartbeatPingDto,
  type HeartbeatPingKind,
  type HeartbeatPingsResponse,
} from "@inv/shared";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getAuditCtx, writeAuditDirect } from "../../lib/audit.js";
import { AppError, notFound } from "../../lib/errors.js";
import { can } from "../../lib/permissions.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import { assertSchedulable, computeAfterEdit } from "../../services/heartbeat-schedule.js";
import {
  PUBLIC_BASE_URL_WARNING,
  buildPingUrl,
  generateHeartbeatToken,
  getHeartbeatConfig,
  heartbeatInclude,
  lastCompletionAt,
  loadRecentPings,
  parseCronSource,
  revealHeartbeatToken,
  toHeartbeatDto,
  type HeartbeatWithServer,
} from "../../services/heartbeat.service.js";
import { CronWriteUnconfirmedError, rewriteCronEntryToken } from "../../services/heartbeat-cron.service.js";
import { cronErrorToHttp } from "../../services/cron.service.js";

/**
 * Heartbeat management — mounted at /api/v1/heartbeats. The unauthenticated
 * check-in endpoints live in heartbeat-ping.routes.ts under /api/v1/ping.
 *
 * viewer: read · editor: create/update · admin: delete. Job output (ping bodies)
 * and the ping URL are shown only to callers who could rotate the token anyway:
 * output routinely contains hostnames, paths and the occasional secret.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

const DETAIL_PINGS = 50;

function toPingDto(
  p: {
    id: number;
    kind: string;
    exitCode: number | null;
    durationMs: number | null;
    remoteIp: string | null;
    userAgent: string | null;
    body: string | null;
    bodyTruncated: boolean;
    createdAt: Date;
  },
  withBody: boolean,
): HeartbeatPingDto {
  return {
    id: p.id,
    kind: p.kind as HeartbeatPingKind,
    exitCode: p.exitCode,
    durationMs: p.durationMs,
    remoteIp: p.remoteIp,
    userAgent: p.userAgent,
    body: withBody ? p.body : null,
    bodyTruncated: p.bodyTruncated,
    createdAt: p.createdAt.toISOString(),
  };
}

async function loadHeartbeat(id: number): Promise<HeartbeatWithServer> {
  const hb = await prisma.heartbeat.findUnique({ where: { id }, include: heartbeatInclude });
  if (!hb) throw notFound("Heartbeat");
  return hb;
}

async function assertServerExists(serverId: number | null | undefined): Promise<void> {
  if (serverId === null || serverId === undefined) return;
  const s = await prisma.server.findFirst({ where: { id: serverId, deletedAt: null }, select: { id: true } });
  if (!s) throw new AppError("VALIDATION_ERROR", `Server ${serverId} does not exist`, 400);
}

function checkSchedule(kind: string, schedule: string | null, timezone: string, periodSeconds: number | null): void {
  if (kind === "cron") {
    if (!schedule) throw new AppError("VALIDATION_ERROR", "A cron heartbeat needs a schedule", 400);
    try {
      assertSchedulable(schedule, timezone);
    } catch (err) {
      throw new AppError("VALIDATION_ERROR", err instanceof Error ? err.message : "Invalid schedule", 400);
    }
  } else if (!periodSeconds) {
    throw new AppError("VALIDATION_ERROR", "A period heartbeat needs a period", 400);
  }
}

/** Audit-safe view of a row: never the token material. */
function auditView(hb: HeartbeatWithServer): Record<string, unknown> {
  return {
    name: hb.name,
    kind: hb.kind,
    schedule: hb.schedule,
    timezone: hb.timezone,
    periodSeconds: hb.periodSeconds,
    graceSeconds: hb.graceSeconds,
    maxRuntimeSeconds: hb.maxRuntimeSeconds,
    serverId: hb.serverId,
    notifyOnLate: hb.notifyOnLate,
    resumeOnPing: hb.resumeOnPing,
    status: hb.status,
    tokenPrefix: hb.tokenPrefix,
  };
}

export const heartbeatRoutes = new Hono()
  .use(requireSession)

  // GET /heartbeats/config — whether ping URLs can be built (PUBLIC_BASE_URL)
  .get("/config", requirePermission({ heartbeat: ["read"] }), (c) => c.json(getHeartbeatConfig()))

  // GET /heartbeats?serverId&status
  .get("/", requirePermission({ heartbeat: ["read"] }), zValidator("query", HeartbeatListQuery), async (c) => {
    const { serverId, status } = c.req.valid("query");
    const rows = await prisma.heartbeat.findMany({
      where: { ...(serverId ? { serverId } : {}), ...(status ? { status } : {}) },
      include: heartbeatInclude,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 1000,
    });
    const pings = await loadRecentPings(rows.map((r) => r.id));
    const body: HeartbeatListResponse = {
      items: rows.map((r) => toHeartbeatDto(r, pings.get(r.id) ?? [])),
      total: rows.length,
      meta: getHeartbeatConfig(),
    };
    return c.json(body);
  })

  // POST /heartbeats → {heartbeat, token, pingUrl}; the token is shown this once
  .post("/", requirePermission({ heartbeat: ["create"] }), zValidator("json", HeartbeatCreateInput), async (c) => {
    const input = c.req.valid("json");
    const user = c.get("user");
    await assertServerExists(input.serverId);
    const schedule = input.kind === "cron" ? (input.schedule ?? null) : null;
    const periodSeconds = input.kind === "period" ? (input.periodSeconds ?? null) : null;
    checkSchedule(input.kind, schedule, input.timezone, periodSeconds);

    const tok = generateHeartbeatToken();
    const hb = await prisma.heartbeat.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        serverId: input.serverId ?? null,
        kind: input.kind,
        schedule,
        timezone: input.timezone,
        periodSeconds,
        graceSeconds: input.graceSeconds,
        maxRuntimeSeconds: input.maxRuntimeSeconds ?? null,
        resumeOnPing: input.resumeOnPing,
        notifyOnLate: input.notifyOnLate,
        tokenHash: tok.tokenHash,
        tokenEnc: tok.tokenEnc,
        tokenPrefix: tok.tokenPrefix,
        // Nothing is expected until the first ping: the job may not be wired up yet.
        status: "new",
        createdById: user.id,
      },
      include: heartbeatInclude,
    });

    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "data",
      action: "heartbeat.create",
      entity: "Heartbeat",
      entityId: String(hb.id),
      after: auditView(hb),
    });

    const pingUrl = buildPingUrl(tok.token);
    const body: HeartbeatCreatedResponse = {
      heartbeat: toHeartbeatDto(hb),
      token: tok.token,
      pingUrl,
      ...(pingUrl ? {} : { warning: PUBLIC_BASE_URL_WARNING }),
    };
    return c.json(body, 201);
  })

  // GET /heartbeats/:id (+ newest 50 pings)
  .get("/:id", requirePermission({ heartbeat: ["read"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const hb = await loadHeartbeat(id);
    const canUpdate = can(c.get("user").role, "heartbeat", "update");
    const pings = await prisma.heartbeatPing.findMany({
      where: { heartbeatId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DETAIL_PINGS,
    });
    const token = canUpdate ? revealHeartbeatToken(hb.tokenEnc) : null;
    const body: HeartbeatDetailResponse = {
      heartbeat: toHeartbeatDto(hb),
      pings: pings.map((p) => toPingDto(p, canUpdate)),
      token,
      pingUrl: token ? buildPingUrl(token) : null,
    };
    return c.json(body);
  })

  // PATCH /heartbeats/:id — deadlines are recomputed when the schedule changes
  .patch(
    "/:id",
    requirePermission({ heartbeat: ["update"] }),
    zValidator("param", idParam),
    zValidator("json", HeartbeatUpdateInput),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const before = await loadHeartbeat(id);
      if (input.serverId !== undefined && input.serverId !== before.serverId) await assertServerExists(input.serverId);

      const kind = input.kind ?? before.kind;
      const merged = {
        kind,
        schedule: kind === "cron" ? (input.schedule !== undefined ? input.schedule : before.schedule) : null,
        timezone: input.timezone ?? before.timezone,
        periodSeconds: kind === "period" ? (input.periodSeconds !== undefined ? input.periodSeconds : before.periodSeconds) : null,
        graceSeconds: input.graceSeconds ?? before.graceSeconds,
        maxRuntimeSeconds: input.maxRuntimeSeconds !== undefined ? input.maxRuntimeSeconds : before.maxRuntimeSeconds,
      };
      checkSchedule(merged.kind, merged.schedule, merged.timezone, merged.periodSeconds);

      const data: Prisma.HeartbeatUpdateInput = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.serverId !== undefined
          ? { server: input.serverId === null ? { disconnect: true } : { connect: { id: input.serverId } } }
          : {}),
        ...(input.resumeOnPing !== undefined ? { resumeOnPing: input.resumeOnPing } : {}),
        ...(input.notifyOnLate !== undefined ? { notifyOnLate: input.notifyOnLate } : {}),
        ...merged,
      };

      const timingChanged =
        merged.kind !== before.kind ||
        merged.schedule !== before.schedule ||
        merged.timezone !== before.timezone ||
        merged.periodSeconds !== before.periodSeconds ||
        merged.graceSeconds !== before.graceSeconds ||
        merged.maxRuntimeSeconds !== before.maxRuntimeSeconds;
      if (timingChanged && before.status !== "paused") {
        const now = new Date();
        // "Armed" = it already had a deadline. A hand-made heartbeat that has never
        // pinged stays unarmed; an edit must not start the clock for it.
        const d = computeAfterEdit(merged, lastCompletionAt(before), now, before.alertAt !== null);
        data.expectedAt = d.expectedAt;
        data.alertAt = d.alertAt;
        if (before.status === "late" && d.expectedAt && d.expectedAt > now) data.status = "up";
      }

      const hb = await prisma.heartbeat.update({ where: { id }, data, include: heartbeatInclude });
      await writeAuditDirect({
        ctx: getAuditCtx(c),
        category: "data",
        action: "heartbeat.update",
        entity: "Heartbeat",
        entityId: String(id),
        before: auditView(before),
        after: auditView(hb),
      });
      return c.json({ heartbeat: toHeartbeatDto(hb) });
    },
  )

  // DELETE /heartbeats/:id — admin
  .delete("/:id", requirePermission({ heartbeat: ["delete"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const hb = await loadHeartbeat(id);
    await prisma.heartbeat.delete({ where: { id } });
    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "data",
      action: "heartbeat.delete",
      entity: "Heartbeat",
      entityId: String(id),
      before: auditView(hb),
    });
    return c.json({ ok: true, cronLinked: parseCronSource(hb.cronSource) !== null });
  })

  // POST /heartbeats/:id/pause
  .post("/:id/pause", requirePermission({ heartbeat: ["update"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const before = await loadHeartbeat(id);
    if (before.status === "paused") return c.json({ heartbeat: toHeartbeatDto(before) });
    const hb = await prisma.heartbeat.update({
      where: { id },
      data: { status: "paused", expectedAt: null, alertAt: null },
      include: heartbeatInclude,
    });
    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "data",
      action: "heartbeat.pause",
      entity: "Heartbeat",
      entityId: String(id),
      before: { status: before.status },
      after: { status: "paused" },
    });
    return c.json({ heartbeat: toHeartbeatDto(hb) });
  })

  // POST /heartbeats/:id/resume
  .post("/:id/resume", requirePermission({ heartbeat: ["update"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const before = await loadHeartbeat(id);
    if (before.status !== "paused") return c.json({ heartbeat: toHeartbeatDto(before) });
    const now = new Date();
    const done = lastCompletionAt(before);
    // It was running before the pause (or lives on a crontab): start the clock again.
    const armed = done !== null || parseCronSource(before.cronSource) !== null;
    const d = computeAfterEdit(before, done, now, armed);
    const hb = await prisma.heartbeat.update({
      where: { id },
      data: { status: "new", expectedAt: d.expectedAt, alertAt: d.alertAt },
      include: heartbeatInclude,
    });
    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "data",
      action: "heartbeat.resume",
      entity: "Heartbeat",
      entityId: String(id),
      before: { status: "paused" },
      after: { status: "new", expectedAt: d.expectedAt, alertAt: d.alertAt },
    });
    return c.json({ heartbeat: toHeartbeatDto(hb) });
  })

  // POST /heartbeats/:id/rotate-token {rewriteCron?} → {heartbeat, token, pingUrl}
  .post("/:id/rotate-token", requirePermission({ heartbeat: ["update"] }), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const parsed = HeartbeatRotateInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid request body", 400);
    const { rewriteCron } = parsed.data;
    const user = c.get("user");
    const before = await loadHeartbeat(id);
    const linked = parseCronSource(before.cronSource) !== null;
    if (rewriteCron && linked) await assertFeatureEnabled("remote_cron");

    const tok = generateHeartbeatToken();
    const hb = await prisma.heartbeat.update({
      where: { id },
      data: { tokenHash: tok.tokenHash, tokenEnc: tok.tokenEnc, tokenPrefix: tok.tokenPrefix },
      include: heartbeatInclude,
    });

    let cronRewritten = false;
    if (rewriteCron && linked) {
      try {
        await rewriteCronEntryToken(before, before.tokenHash, tok.token, {
          role: user.role,
          audit: getAuditCtx(c),
          overridePassword: c.req.header("x-ssh-password") || undefined,
        });
        cronRewritten = true;
      } catch (err) {
        if (err instanceof CronWriteUnconfirmedError) {
          // The host may already carry the new token: keep it, and say so.
          await writeAuditDirect({
            ctx: getAuditCtx(c),
            category: "security",
            action: "heartbeat.rotate_token",
            entity: "Heartbeat",
            entityId: String(id),
            before: { tokenPrefix: before.tokenPrefix },
            after: { tokenPrefix: tok.tokenPrefix, cronRewritten: false, unconfirmed: true },
          });
          return c.json({ error: { code: "CRON_WRITE_UNCONFIRMED", message: err.message, details: { heartbeatId: id } } }, 502);
        }
        // The crontab still carries the old token: put it back so the job keeps working.
        await prisma.heartbeat.update({
          where: { id },
          data: { tokenHash: before.tokenHash, tokenEnc: before.tokenEnc, tokenPrefix: before.tokenPrefix },
        });
        if (err instanceof AppError) throw err;
        const { status, code, message } = cronErrorToHttp(err);
        return c.json({ error: { code, message } }, status);
      }
    }

    await writeAuditDirect({
      ctx: getAuditCtx(c),
      category: "security",
      action: "heartbeat.rotate_token",
      entity: "Heartbeat",
      entityId: String(id),
      before: { tokenPrefix: before.tokenPrefix },
      after: { tokenPrefix: tok.tokenPrefix, cronRewritten },
    });

    const pingUrl = buildPingUrl(tok.token);
    return c.json({
      heartbeat: toHeartbeatDto(hb),
      token: tok.token,
      pingUrl,
      cronRewritten,
      ...(linked && !cronRewritten
        ? { warning: "This heartbeat is linked to a crontab line that still uses the old token. Rewrite the line, or its pings will be rejected." }
        : !pingUrl
          ? { warning: PUBLIC_BASE_URL_WARNING }
          : {}),
    });
  })

  // GET /heartbeats/:id/pings?cursor&limit
  .get(
    "/:id/pings",
    requirePermission({ heartbeat: ["read"] }),
    zValidator("param", idParam),
    zValidator("query", HeartbeatPingsQuery),
    async (c) => {
      const { id } = c.req.valid("param");
      const { cursor, limit } = c.req.valid("query");
      await loadHeartbeat(id);
      const canUpdate = can(c.get("user").role, "heartbeat", "update");
      const rows = await prisma.heartbeatPing.findMany({
        where: { heartbeatId: id, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: { id: "desc" },
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const body: HeartbeatPingsResponse = {
        items: page.map((p) => toPingDto(p, canUpdate)),
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      };
      return c.json(body);
    },
  );
