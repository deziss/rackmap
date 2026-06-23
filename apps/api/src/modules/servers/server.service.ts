import { prisma } from "../../db.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { notFound, conflict } from "../../lib/errors.js";
import { writeAudit, redact, type AuditCtx } from "../../lib/audit.js";
import type { ServerCreateInput, ServerUpdateInput, ServerListQuery } from "@inv/shared";

// Single shared select — passwordEnc NEVER included
export const serverSelect = {
  id: true,
  hostname: true,
  ip: true,
  username: true,
  passwordEnc: true, // only to derive hasPassword; stripped before returning
  sshPort: true,
  cpu: true,
  ram: true,
  gpuCount: true,
  remark: true,
  domain: true,
  environment: true,
  cloudProvider: { select: { id: true, name: true } },
  gpuType: { select: { id: true, name: true } },
  allocatedTo: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  serverType: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
  lastStatus: true,
  lastCheckedAt: true,
  lastLatencyMs: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  updatedByEmail: true,
} as const;

/** Strip passwordEnc and add hasPassword. */
function toDto(raw: { passwordEnc: string | null; tags: { tag: { id: number; name: string; color: string | null } }[]; [key: string]: unknown }) {
  const { passwordEnc, tags, ...rest } = raw;
  return {
    ...rest,
    hasPassword: passwordEnc !== null,
    tags: tags.map((t) => t.tag),
  };
}

export async function listServers(query: ServerListQuery, isAdmin: boolean) {
  const { cursor, limit = 50, q, cloudProviderId, gpuTypeId, allocatedToId, locationId, serverTypeId, tagId, status, includeDeleted } = query;

  const showDeleted = isAdmin && includeDeleted;

  const where = {
    ...(showDeleted ? {} : { deletedAt: null }),
    ...(q ? {
      OR: [
        { hostname: { contains: q } },
        { ip: { contains: q } },
        { username: { contains: q } },
        { remark: { contains: q } },
      ],
    } : {}),
    ...(cloudProviderId ? { cloudProviderId } : {}),
    ...(gpuTypeId ? { gpuTypeId } : {}),
    ...(allocatedToId ? { allocatedToId } : {}),
    ...(locationId ? { locationId } : {}),
    ...(serverTypeId ? { serverTypeId } : {}),
    ...(tagId ? { tags: { some: { tagId } } } : {}),
    ...(status ? { lastStatus: status } : {}),
    ...(cursor ? { id: { lt: cursor } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.server.findMany({
      where,
      select: serverSelect,
      orderBy: { id: "desc" },
      take: limit,
    }),
    prisma.server.count({ where: { ...(showDeleted ? {} : { deletedAt: null }) } }),
  ]);

  const dtos = items.map(toDto);
  const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;

  return { items: dtos, nextCursor, total };
}

export async function getServer(id: number) {
  const server = await prisma.server.findUnique({ where: { id }, select: serverSelect });
  if (!server) throw notFound("Server");
  return toDto(server);
}

export async function createServer(input: ServerCreateInput, ctx: AuditCtx = {}) {
  const { password, tagIds, ...data } = input;
  const server = await prisma.$transaction(async (tx) => {
    const s = await tx.server.create({
      data: {
        ...data,
        passwordEnc: password ? encryptSecret(password) : null,
        updatedByEmail: ctx.actorEmail ?? null,
        tags: tagIds?.length
          ? { create: tagIds.map((tagId) => ({ tag: { connect: { id: tagId } } })) }
          : undefined,
      },
      select: serverSelect,
    });
    await tx.auditLog.create({
      data: {
        category: "data",
        action: "server.create",
        entity: "server",
        entityId: String(s.id),
        actorId: ctx.actorId ?? null,
        actorEmail: ctx.actorEmail ?? null,
        afterJson: JSON.stringify(redact({ ...data, hasPassword: !!password })),
        ip: ctx.ip ?? null,
      },
    });
    return s;
  });
  return toDto(server);
}

export async function updateServer(id: number, input: ServerUpdateInput, ctx: AuditCtx = {}) {
  const existing = await prisma.server.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) throw notFound("Server");

  const { password, tagIds, ...data } = input;

  // password: undefined = unchanged, null = clear, string = re-encrypt
  const passwordEnc =
    password === undefined ? undefined :
    password === null ? null :
    encryptSecret(password);

  const updated = await prisma.$transaction(async (tx) => {
    // Replace tags if tagIds provided
    if (tagIds !== undefined) {
      await tx.serverTag.deleteMany({ where: { serverId: id } });
      if (tagIds.length > 0) {
        await tx.serverTag.createMany({
          data: tagIds.map((tagId) => ({ serverId: id, tagId })),
        });
      }
    }

    const s = await tx.server.update({
      where: { id },
      data: { ...data, ...(passwordEnc !== undefined ? { passwordEnc } : {}), updatedByEmail: ctx.actorEmail ?? null },
      select: serverSelect,
    });

    await tx.auditLog.create({
      data: {
        category: "data",
        action: "server.update",
        entity: "server",
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

export async function softDeleteServer(id: number, ctx: AuditCtx = {}) {
  const existing = await prisma.server.findUnique({ where: { id } });
  if (!existing) throw notFound("Server");
  if (existing.deletedAt) throw conflict("Server already deleted");
  await prisma.$transaction([
    prisma.server.update({ where: { id }, data: { deletedAt: new Date() } }),
    writeAudit({ ctx, category: "data", action: "server.delete", entity: "server", entityId: String(id) }),
  ]);
}

export async function restoreServer(id: number, ctx: AuditCtx = {}) {
  const existing = await prisma.server.findUnique({ where: { id } });
  if (!existing) throw notFound("Server");
  if (!existing.deletedAt) throw conflict("Server is not deleted");
  const server = await prisma.$transaction(async (tx) => {
    const s = await tx.server.update({ where: { id }, data: { deletedAt: null }, select: serverSelect });
    await tx.auditLog.create({
      data: { category: "data", action: "server.restore", entity: "server", entityId: String(id), actorId: ctx.actorId ?? null, actorEmail: ctx.actorEmail ?? null, ip: ctx.ip ?? null },
    });
    return s;
  });
  return toDto(server);
}

/** Returns plaintext password. Caller must audit this. */
export async function revealServerPassword(id: number, ctx: AuditCtx = {}): Promise<string | null> {
  const server = await prisma.server.findUnique({ where: { id }, select: { passwordEnc: true, deletedAt: true } });
  if (!server || server.deletedAt) throw notFound("Server");
  await writeAudit({ ctx, category: "data", action: "server.password_reveal", entity: "server", entityId: String(id) });
  if (!server.passwordEnc) return null;
  return decryptSecret(server.passwordEnc);
}

export async function getStatusHistory(id: number, limit = 50) {
  const exists = await prisma.server.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw notFound("Server");
  return prisma.statusCheck.findMany({
    where: { serverId: id },
    orderBy: { checkedAt: "desc" },
    take: limit,
    select: { id: true, status: true, latencyMs: true, errorCode: true, checkedAt: true },
  });
}
