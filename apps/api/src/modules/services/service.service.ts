import { runServiceCheck } from "../../services/service-status.service.js";
import { prisma } from "../../db.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { reencryptPasswordForStorage } from "../../services/vault.service.js";
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
  nodePort: true,
  role: true,
  accountId: true,
  region: true,
  authTokenEnc: true,
  lastStatus: true,
  lastCheckedAt: true,
  lastLatencyMs: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
} as const;

function toDto(raw: { passwordEnc: string | null; authTokenEnc?: string | null; tags: { tag: { id: number; name: string; color: string | null } }[]; [key: string]: unknown }) {
  const { passwordEnc, authTokenEnc, tags, ...rest } = raw;
  return {
    ...rest,
    hasPassword: passwordEnc !== null,
    hasAuthToken: !!authTokenEnc,
    tags: tags.map((t) => t.tag),
  };
}

export async function listServices(query: ServiceListQuery, isAdmin: boolean) {
  const { cursor, limit = 50, sortBy, sortDir, q, tagId, lastStatus, includeDeleted, page } = query;
  const pageNum = page ? Math.max(1, page) : undefined;
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
    ...(cursor && !sortBy ? { id: { lt: cursor } } : {}),
  };

  let finalOrderBy: any = { id: "desc" };
  if (sortBy) {
    switch (sortBy) {
      case "tags":
        finalOrderBy = { id: sortDir || "desc" }; // Fallback since relation sort is unsupported natively
        break;
      case "password":
        finalOrderBy = { passwordEnc: sortDir || "asc" };
        break;
      default:
        finalOrderBy = { [sortBy]: sortDir || "asc" };
    }
  }

  const orderBy = finalOrderBy;
  const skip = pageNum ? (pageNum - 1) * limit : sortBy ? (cursor || 0) : undefined;

  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where,
      select: serviceSelect,
      orderBy: orderBy as any,
      take: limit,
      skip,
    }),
    prisma.service.count({ where: { ...(showDeleted ? {} : { deletedAt: null }) } }),
  ]);

  const dtos = items.map(toDto);
  const nextCursor = items.length === limit ? (sortBy ? (cursor || 0) + limit : (items[items.length - 1]?.id ?? null)) : null;

  return {
    items: dtos,
    nextCursor,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getService(id: number) {
  const service = await prisma.service.findUnique({ where: { id }, select: serviceSelect });
  if (!service) throw notFound("Service");
  return toDto(service);
}

export async function createService(input: ServiceCreateInput, ctx: AuditCtx = {}) {
  const { password, authToken, tagIds, ...data } = input;
  const service = await prisma.$transaction(async (tx) => {
    const s = await tx.service.create({
      data: {
        ...data,
        // Nothing to upgrade on create: there is no stored row yet and encryptSecret already
        // emits the current envelope for both columns.
        passwordEnc: password ? encryptSecret(password) : null,
        authTokenEnc: authToken ? encryptSecret(authToken) : null,
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
  const dto = toDto(service);
  void runServiceCheck(service.id).catch(() => {});
  return dto;
}

export async function updateService(id: number, input: ServiceUpdateInput, ctx: AuditCtx = {}) {
  const existing = await prisma.service.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) throw notFound("Service");

  // authToken must be destructured out alongside password: the column is
  // `authTokenEnc`, so leaving it in `data` sends Prisma an unknown `authToken`
  // field and the update throws. Updating a service's auth token was therefore
  // impossible, even though ServiceUpdateInput accepts one.
  const { password, authToken, tagIds, ...data } = input;

  const passwordEnc =
    password === undefined ? undefined :
    password === null ? null :
    encryptSecret(password);

  const authTokenEnc =
    authToken === undefined ? undefined :
    authToken === null ? null :
    encryptSecret(authToken);

  /**
   * Lazy envelope upgrade for the two encrypted columns on this row. The row is being written
   * anyway, so a credential still in the legacy unsalted v1 envelope is moved onto the current
   * one for free.
   *
   * Each column is only considered when this request is not itself writing it, so a supplied
   * value (or an explicit clear) always wins over a re-encrypted old one.
   * reencryptPasswordForStorage returns null for a vault-wrapped "v2." blob, for a value
   * already on the current envelope, and for anything that fails to decrypt; null means "leave
   * the column alone", so a failed upgrade never costs a stored credential.
   *
   * Deliberately silent: this is background housekeeping, not an event worth a log line.
   */
  const upgradedPasswordEnc =
    passwordEnc === undefined && existing.passwordEnc
      ? reencryptPasswordForStorage(existing.passwordEnc)
      : null;
  const passwordEncWrite = passwordEnc !== undefined ? passwordEnc : (upgradedPasswordEnc ?? undefined);
  const upgradedAuthTokenEnc =
    authTokenEnc === undefined && existing.authTokenEnc
      ? reencryptPasswordForStorage(existing.authTokenEnc)
      : null;
  const authTokenEncWrite =
    authTokenEnc !== undefined ? authTokenEnc : (upgradedAuthTokenEnc ?? undefined);

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
      data: {
        ...data,
        ...(passwordEncWrite !== undefined ? { passwordEnc: passwordEncWrite } : {}),
        ...(authTokenEncWrite !== undefined ? { authTokenEnc: authTokenEncWrite } : {}),
      },
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
  const dto = toDto(updated);
  if (data.serverIp !== undefined || data.port !== undefined || data.healthUrl !== undefined) {
    void runServiceCheck(id).catch(() => {});
  }
  return dto;
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
