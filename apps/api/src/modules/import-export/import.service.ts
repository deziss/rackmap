import * as XLSX from "xlsx";
import { prisma } from "../../db.js";
import { encryptSecret } from "../../lib/crypto.js";
import { writeAudit, type AuditCtx } from "../../lib/audit.js";

interface ColMapping {
  hostname?: string;
  ip?: string;
  username?: string;
  password?: string;
  sshPort?: string;
  cpu?: string;
  ram?: string;
  gpuCount?: string;
  remark?: string;
  domain?: string;
  environment?: string;
  cloudProvider?: string;
  gpuType?: string;
  allocatedTo?: string;
  location?: string;
  serverType?: string;
}

interface ImportRowResult {
  row: number;
  hostname: string;
  status: "ok" | "error" | "skip";
  message?: string;
}

interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  errors: ImportRowResult[];
}

// Auto-create lookup by name, return id (or null if name blank)
async function resolveOrCreate<T extends { id: number }>(
  model: { findFirst: (q: { where: { name: string } }) => Promise<T | null>; create: (q: { data: { name: string }; select: { id: true } }) => Promise<{ id: number }> },
  name: string | null | undefined,
): Promise<number | null> {
  if (!name?.trim()) return null;
  const clean = name.trim();
  const existing = await model.findFirst({ where: { name: clean } });
  if (existing) return existing.id;
  const created = await model.create({ data: { name: clean }, select: { id: true } });
  return created.id;
}

export async function importServers(
  buffer: Buffer,
  mimeType: string,
  mapping: ColMapping,
  dryRun: boolean,
  ctx: AuditCtx,
): Promise<ImportResult> {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0] ?? ""];
  if (!ws) throw new Error("No worksheet found in file");

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });

  const result: ImportResult = { total: rows.length, created: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const rowNum = i + 2; // 1-indexed + header row

    const hostname = mapping.hostname ? String(row[mapping.hostname] ?? "").trim() : "";
    const ip = mapping.ip ? String(row[mapping.ip] ?? "").trim() : "";

    if (!hostname || !ip) {
      result.errors.push({ row: rowNum, hostname: hostname || "(blank)", status: "error", message: "hostname and ip are required" });
      continue;
    }

    // Check for duplicate hostname
    const existing = await prisma.server.findFirst({ where: { hostname } });
    if (existing) {
      result.skipped++;
      result.errors.push({ row: rowNum, hostname, status: "skip", message: "hostname already exists" });
      continue;
    }

    try {
      const sshPortRaw = mapping.sshPort ? Number(row[mapping.sshPort]) : NaN;
      const sshPort = Number.isFinite(sshPortRaw) && sshPortRaw > 0 ? sshPortRaw : 22;

      const username = mapping.username ? String(row[mapping.username] ?? "").trim() : "";
      const password = mapping.password ? String(row[mapping.password] ?? "").trim() || null : null;
      const cpu = mapping.cpu ? String(row[mapping.cpu] ?? "").trim() || null : null;
      const ram = mapping.ram ? String(row[mapping.ram] ?? "").trim() || null : null;
      const gpuCountRaw = mapping.gpuCount ? Number(row[mapping.gpuCount]) : NaN;
      const gpuCount = Number.isFinite(gpuCountRaw) ? gpuCountRaw : null;
      const remark = mapping.remark ? String(row[mapping.remark] ?? "").trim() || null : null;

      const domain = mapping.domain ? String(row[mapping.domain] ?? "").trim() : null;
      const environmentRaw = mapping.environment ? String(row[mapping.environment] ?? "").trim().toLowerCase() : null;
      const environment = environmentRaw === "cloud" ? "cloud" : "on-premise";
      const cloudProviderName = mapping.cloudProvider ? String(row[mapping.cloudProvider] ?? "").trim() : null;
      const gpuTypeName = mapping.gpuType ? String(row[mapping.gpuType] ?? "").trim() : null;
      const allocatedToName = mapping.allocatedTo ? String(row[mapping.allocatedTo] ?? "").trim() : null;
      const locationName = mapping.location ? String(row[mapping.location] ?? "").trim() : null;
      const serverTypeName = mapping.serverType ? String(row[mapping.serverType] ?? "").trim() : null;

      if (!dryRun) {
        const [cloudProviderId, gpuTypeId, allocatedToId, locationId, serverTypeId] = await Promise.all([
          resolveOrCreate(prisma.cloudProvider, cloudProviderName),
          resolveOrCreate(prisma.gpuType, gpuTypeName),
          resolveOrCreate(prisma.allocatedTo, allocatedToName),
          resolveOrCreate(prisma.location, locationName),
          resolveOrCreate(prisma.serverType, serverTypeName),
        ]);

        await prisma.$transaction(async (tx) => {
          const s = await tx.server.create({
            data: {
              hostname,
              ip,
              username: username || "root",
              passwordEnc: password ? encryptSecret(password) : null,
              sshPort,
              cpu,
              ram,
              gpuCount,
              remark,
              domain,
              environment,
              cloudProviderId,
              gpuTypeId,
              allocatedToId,
              locationId,
              serverTypeId,
            },
          });
          await tx.auditLog.create({
            data: {
              category: "data",
              action: "server.import",
              entity: "server",
              entityId: String(s.id),
              actorId: ctx.actorId ?? null,
              actorEmail: ctx.actorEmail ?? null,
              afterJson: JSON.stringify({ hostname, ip, sshPort }),
              ip: ctx.ip ?? null,
            },
          });
        });
      }

      result.created++;
      result.errors.push({ row: rowNum, hostname, status: "ok" });
    } catch (err: unknown) {
      result.errors.push({ row: rowNum, hostname, status: "error", message: (err as Error).message });
    }
  }

  return result;
}

export async function exportServers(filters: Record<string, string | undefined>): Promise<Buffer> {
  const where = {
    deletedAt: null,
    ...(filters.q ? {
      OR: [
        { hostname: { contains: filters.q } },
        { ip: { contains: filters.q } },
      ],
    } : {}),
    ...(filters.cloudProviderId ? { cloudProviderId: Number(filters.cloudProviderId) } : {}),
    ...(filters.locationId ? { locationId: Number(filters.locationId) } : {}),
    ...(filters.gpuTypeId ? { gpuTypeId: Number(filters.gpuTypeId) } : {}),
    ...(filters.allocatedToId ? { allocatedToId: Number(filters.allocatedToId) } : {}),
    ...(filters.serverTypeId ? { serverTypeId: Number(filters.serverTypeId) } : {}),
    ...(filters.status ? { lastStatus: filters.status } : {}),
  };

  const servers = await prisma.server.findMany({
    where,
    orderBy: { id: "asc" },
    select: {
      id: true,
      hostname: true,
      ip: true,
      sshPort: true,
      username: true,
      cpu: true,
      ram: true,
      gpuCount: true,
      remark: true,
      lastStatus: true,
      lastCheckedAt: true,
      lastLatencyMs: true,
      domain: true,
      environment: true,
      cloudProvider: { select: { name: true } },
      gpuType: { select: { name: true } },
      allocatedTo: { select: { name: true } },
      location: { select: { name: true } },
      serverType: { select: { name: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });

  const rows = servers.map((s) => ({
    "SR N": s.id,
    DOMAIN: s.domain ?? "",
    ENVIRONMENT: s.environment ?? "",
    "CLOUD PROVIDER": s.cloudProvider?.name ?? "",
    HOSTNAME: s.hostname,
    SERVER_IP: s.ip,
    SSH_PORT: s.sshPort,
    USER: s.username,
    CPU: s.cpu ?? "",
    RAM: s.ram ?? "",
    "GPU TYPE": s.gpuType?.name ?? "",
    "GPU COUNT": s.gpuCount ?? "",
    "ALLOCATED TO": s.allocatedTo?.name ?? "",
    LOCATION: s.location?.name ?? "",
    "SERVER TYPE": s.serverType?.name ?? "",
    TAGS: s.tags.map((t) => t.tag.name).join(", "),
    STATUS: s.lastStatus ?? "",
    "LAST CHECKED": s.lastCheckedAt?.toISOString() ?? "",
    "LATENCY MS": s.lastLatencyMs ?? "",
    REMARK: s.remark ?? "",
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Servers");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buf;
}

export async function exportServersJson(filters: Record<string, string | undefined>): Promise<string> {
  const where = {
    deletedAt: null,
    ...(filters.q ? { OR: [{ hostname: { contains: filters.q } }, { ip: { contains: filters.q } }] } : {}),
    ...(filters.cloudProviderId ? { cloudProviderId: Number(filters.cloudProviderId) } : {}),
    ...(filters.locationId ? { locationId: Number(filters.locationId) } : {}),
    ...(filters.gpuTypeId ? { gpuTypeId: Number(filters.gpuTypeId) } : {}),
    ...(filters.allocatedToId ? { allocatedToId: Number(filters.allocatedToId) } : {}),
    ...(filters.serverTypeId ? { serverTypeId: Number(filters.serverTypeId) } : {}),
    ...(filters.status ? { lastStatus: filters.status } : {}),
  };

  const servers = await prisma.server.findMany({
    where,
    orderBy: { id: "asc" },
    select: {
      id: true, hostname: true, ip: true, sshPort: true, username: true,
      cpu: true, ram: true, gpuCount: true, remark: true,
      lastStatus: true, lastCheckedAt: true, lastLatencyMs: true,
      domain: true, environment: true,
      cloudProvider: { select: { name: true } },
      gpuType: { select: { name: true } },
      allocatedTo: { select: { name: true } },
      location: { select: { name: true } },
      serverType: { select: { name: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });

  return JSON.stringify(servers.map((s) => ({
    id: s.id, hostname: s.hostname, ip: s.ip, sshPort: s.sshPort, username: s.username,
    domain: s.domain, environment: s.environment,
    cloudProvider: s.cloudProvider?.name ?? null,
    gpuType: s.gpuType?.name ?? null, gpuCount: s.gpuCount,
    allocatedTo: s.allocatedTo?.name ?? null,
    location: s.location?.name ?? null,
    serverType: s.serverType?.name ?? null,
    cpu: s.cpu, ram: s.ram,
    tags: s.tags.map((t) => t.tag.name),
    status: s.lastStatus,
    lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
    latencyMs: s.lastLatencyMs,
    remark: s.remark,
  })), null, 2);
}
