import { prisma } from "../../db.js";
import type { LookupType } from "@inv/shared";
import { notFound, conflict } from "../../lib/errors.js";

// Map URL segment to Prisma delegate
function delegate(type: LookupType) {
  const map = {
    "cloud-providers": prisma.cloudProvider,
    "gpu-types": prisma.gpuType,
    "allocated-to": prisma.allocatedTo,
    locations: prisma.location,
    "server-types": prisma.serverType,
    "network-types": prisma.networkType,
  } as const;
  return map[type] as {
    findMany: (args?: object) => Promise<{ id: number; name: string; createdAt: Date; updatedAt: Date }[]>;
    findUnique: (args: object) => Promise<{ id: number; name: string } | null>;
    create: (args: object) => Promise<{ id: number; name: string; createdAt: Date; updatedAt: Date }>;
    update: (args: object) => Promise<{ id: number; name: string; createdAt: Date; updatedAt: Date }>;
    delete: (args: object) => Promise<{ id: number; name: string }>;
    count: (args: object) => Promise<number>;
  };
}

export async function listLookups(type: LookupType) {
  return delegate(type).findMany({ orderBy: { name: "asc" } });
}

export async function createLookup(type: LookupType, name: string) {
  const existing = await delegate(type).findUnique({ where: { name } });
  if (existing) throw conflict(`${name} already exists`);
  return delegate(type).create({ data: { name } });
}

export async function updateLookup(type: LookupType, id: number, name: string) {
  const existing = await delegate(type).findUnique({ where: { id } });
  if (!existing) throw notFound("Lookup entry");
  const dup = await delegate(type).findUnique({ where: { name } });
  if (dup && dup.id !== id) throw conflict(`${name} already exists`);
  return delegate(type).update({ where: { id }, data: { name } });
}

export async function deleteLookup(type: LookupType, id: number) {
  const existing = await delegate(type).findUnique({ where: { id } });
  if (!existing) throw notFound("Lookup entry");
  // Check for referencing servers using the Server table
  const fkCol = {
    "cloud-providers": "cloudProviderId",
    "gpu-types": "gpuTypeId",
    "allocated-to": "allocatedToId",
    locations: "locationId",
    "server-types": "serverTypeId",
    "network-types": "networkTypeId",
  }[type] as string;
  const serverCount = await prisma.server.count({ where: { [fkCol]: id } });
  if (serverCount > 0) {
    throw conflict(`Cannot delete: ${serverCount} server(s) reference this entry`);
  }
  return delegate(type).delete({ where: { id } });
}
