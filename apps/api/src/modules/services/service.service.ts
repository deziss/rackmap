import { prisma } from "../../db.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { notFound, conflict } from "../../lib/errors.js";
import { writeAudit, redact, type AuditCtx } from "../../lib/audit.js";
import type { ServiceCreateInput, ServiceUpdateInput, ServiceListQuery } from "@inv/shared";

const serviceSelect = {
  id: true,
  serviceName: true,
  serviceType: true,
  serverIp: true,
  port: true,
  domain: true,
  username: true,
  passwordEnc: true,
  documentLink: true,
  project: true,
  version: true,
  environment: true,
  dbName: true,
  managedBy: true,
  remark: true,
  healthUrl: true,
  status: true,
  lastStatus: true,
  lastCheckedAt: true,
  lastLatencyMs: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
} as const;

function toDto(raw: { passwordEnc: string | null; tags: { tag: { id: number; name: string; color: string | null } }[]; [key: string]: unknown }) {
  const { passwordEnc, tags, ...rest } = raw;
  return {
    ...rest,
    hasPassword: passwordEnc !== null,
    tags: tags.map((t) => t.tag),
  };
}

export async function listServices(query: ServiceListQuery, isAdmin: boolean) {
  const { cursor, limit = 50, q, tagId, lastStatus, includeDeleted } = query;
  const showDeleted = isAdmin && includeDeleted;

  const where = {
    ...(showDeleted ? {} : { deletedAt: null }),
    ...(q ? {
      OR: [
        { serviceName: { contains: q } },
        { serverIp: { contains: q } },
        { domain: { contains: q } },
        { project: { contains: q } },
        { remark: { contains: q } },
      ],
    } : {}),
    ...(tagId ? { tags: { some: { tagId } } } : {}),
    ...(lastStatus ? { lastStatus } : {}),
    ...(cursor ? { id: { lt: cursor } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where,
      select: serviceSelect,
      orderBy: { id: "desc" },
      take: limit,
    }),
    prisma.service.count({ where: { ...(showDeleted ? {} : { deletedAt: null }) } }),
  ]);

  const dtos = items.map(toDto);
  const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;

  return { items: dtos, nextCursor, total };
}

export async function getService(id: number) {
  const service = await prisma.service.findUnique({ where: { id }, select: serviceSelect });
  if (!service) throw notFound("Service");
  return toDto(service);
}

export async function createService(input: ServiceCreateInput, ctx: AuditCtx = {}) {
  const { password, tagIds, ...data } = input;
  const service = await prisma.$transaction(async (tx) => {
    const s = await tx.service.create({
      data: {
        ...data,
        passwordEnc: password ? encryptSecret(password) : null,
        tags: tagIds?.length
          ? { create: tagIds.map((tagId) => ({ tag: { connect: { id: tagId } } })) }
          : undefined,
      },
      select: serviceSelect,
    });
    await tx.auditLog.create({
      data: {
        category: "data",
        action: "service.create",
        entity: "service",
        entityId: String(s.id),
        actorId: ctx.actorId ?? null,
        actorEmail: ctx.actorEmail ?? null,
        afterJson: JSON.stringify(redact({ ...data, hasPassword: !!password })),
        ip: ctx.ip ?? null,
      },
    });
    return s;
  });
  return toDto(service);
}

export async function updateService(id: number, input: ServiceUpdateInput, ctx: AuditCtx = {}) {
  const existing = await prisma.service.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) throw notFound("Service");

  const { password, tagIds, ...data } = input;

  const passwordEnc =
    password === undefined ? undefined :
    password === null ? null :
    encryptSecret(password);

  const updated = await prisma.$transaction(async (tx) => {
    if (tagIds !== undefined) {
      await tx.serviceTag.deleteMany({ where: { serviceId: id } });
      if (tagIds.length > 0) {
        await tx.serviceTag.createMany({
          data: tagIds.map((tagId) => ({ serviceId: id, tagId })),
        });
      }
    }

    const s = await tx.service.update({
      where: { id },
      data: { ...data, ...(passwordEnc !== undefined ? { passwordEnc } : {}) },
      select: serviceSelect,
    });

    await tx.auditLog.create({
      data: {
        category: "data",
        action: "service.update",
        entity: "service",
        entityId: String(id),
        actorId: ctx.actorId ?? null,
        actorEmail: ctx.actorEmail ?? null,
        diffJson: JSON.stringify(redact({ ...data, ...(password !== undefined ? { hasPassword: !!password } : {}) })),
        ip: ctx.ip ?? null,
      },
    });
    return s;
  });
  return toDto(updated);
}

export async function softDeleteService(id: number, ctx: AuditCtx = {}) {
  const existing = await prisma.service.findUnique({ where: { id } });
  if (!existing) throw notFound("Service");
  if (existing.deletedAt) throw conflict("Service already deleted");
  await prisma.$transaction([
    prisma.service.update({ where: { id }, data: { deletedAt: new Date() } }),
    writeAudit({ ctx, category: "data", action: "service.delete", entity: "service", entityId: String(id) }),
  ]);
}

export async function restoreService(id: number, ctx: AuditCtx = {}) {
  const existing = await prisma.service.findUnique({ where: { id } });
  if (!existing) throw notFound("Service");
  if (!existing.deletedAt) throw conflict("Service is not deleted");
  const service = await prisma.$transaction(async (tx) => {
    const s = await tx.service.update({ where: { id }, data: { deletedAt: null }, select: serviceSelect });
    await tx.auditLog.create({
      data: { category: "data", action: "service.restore", entity: "service", entityId: String(id), actorId: ctx.actorId ?? null, actorEmail: ctx.actorEmail ?? null, ip: ctx.ip ?? null },
    });
    return s;
  });
  return toDto(service);
}

export async function revealServicePassword(id: number, ctx: AuditCtx = {}): Promise<string | null> {
  const service = await prisma.service.findUnique({ where: { id }, select: { passwordEnc: true, deletedAt: true } });
  if (!service || service.deletedAt) throw notFound("Service");
  await writeAudit({ ctx, category: "data", action: "service.password_reveal", entity: "service", entityId: String(id) });
  if (!service.passwordEnc) return null;
  return decryptSecret(service.passwordEnc);
}
