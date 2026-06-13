import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { AuditAction, AuditCategory } from "@inv/shared";

/** Fields that must never appear in audit JSON */
const REDACTED_FIELDS = new Set(["passwordEnc", "password"]);

export function redact(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACTED_FIELDS.has(k) ? "[REDACTED]" : v;
  }
  return out;
}

/** Shallow diff — returns only the keys that changed (with after values). */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!before || !after) return after ?? {};
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed[key] = after[key];
    }
  }
  return changed;
}

export interface AuditCtx {
  actorId?: string | null;
  actorEmail?: string | null;
  ip?: string | null;
}

export interface WriteAuditArgs {
  ctx: AuditCtx;
  category: AuditCategory;
  action: AuditAction;
  entity?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Returns a Prisma create operation suitable for use inside `$transaction`.
 * Usage: `prisma.$transaction([mutation, writeAudit({...})])`
 */
export function writeAudit(args: WriteAuditArgs): Prisma.PrismaPromise<unknown> {
  const { ctx, category, action, entity, entityId, before, after } = args;
  const beforeR = before ? redact(before) : null;
  const afterR = after ? redact(after) : null;
  const diffR = before && after ? diff(beforeR ?? {}, afterR ?? {}) : afterR ?? null;

  return prisma.auditLog.create({
    data: {
      category,
      action,
      entity: entity ?? null,
      entityId: entityId ?? null,
      actorId: ctx.actorId ?? null,
      actorEmail: ctx.actorEmail ?? null,
      beforeJson: beforeR ? JSON.stringify(beforeR) : null,
      afterJson: afterR ? JSON.stringify(afterR) : null,
      diffJson: diffR ? JSON.stringify(diffR) : null,
      ip: ctx.ip ?? null,
    },
  });
}

/** Write audit outside a transaction (for auth events). */
export async function writeAuditDirect(args: WriteAuditArgs) {
  return writeAudit(args);
}

export function getAuditCtx(c: { req: { header: (k: string) => string | undefined }; get: (k: string) => unknown }): AuditCtx {
  const user = c.get("user") as { id?: string; email?: string } | undefined;
  return {
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
  };
}
