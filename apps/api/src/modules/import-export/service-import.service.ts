import * as XLSX from "xlsx";
import { prisma } from "../../db.js";
import { encryptSecret } from "../../lib/crypto.js";
import { writeAudit, type AuditCtx } from "../../lib/audit.js";

interface ColMapping {
  serviceName?: string;
  serviceType?: string;
  serverIp?: string;
  port?: string;
  domain?: string;
  username?: string;
  password?: string;
  documentLink?: string;
  project?: string;
  version?: string;
  environment?: string;
  dbName?: string;
  managedBy?: string;
  healthUrl?: string;
  remark?: string;
}

interface ImportRowResult {
  row: number;
  serviceName: string;
  status: "ok" | "error" | "skip";
  message?: string;
}

interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  errors: ImportRowResult[];
}

export async function importServices(
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

    const serviceName = mapping.serviceName ? String(row[mapping.serviceName] ?? "").trim() : "";

    if (!serviceName) {
      result.errors.push({ row: rowNum, serviceName: "(blank)", status: "error", message: "Service Name is required" });
      continue;
    }

    try {
      const serviceType = mapping.serviceType ? String(row[mapping.serviceType] ?? "").trim() || null : null;
      const serverIp = mapping.serverIp ? String(row[mapping.serverIp] ?? "").trim() || null : null;
      const port = mapping.port ? String(row[mapping.port] ?? "").trim() || null : null;
      const domain = mapping.domain ? String(row[mapping.domain] ?? "").trim() || null : null;
      const username = mapping.username ? String(row[mapping.username] ?? "").trim() || null : null;
      const password = mapping.password ? String(row[mapping.password] ?? "").trim() || null : null;
      const documentLink = mapping.documentLink ? String(row[mapping.documentLink] ?? "").trim() || null : null;
      const project = mapping.project ? String(row[mapping.project] ?? "").trim() || null : null;
      const version = mapping.version ? String(row[mapping.version] ?? "").trim() || null : null;
      const environmentRaw = mapping.environment ? String(row[mapping.environment] ?? "").trim().toLowerCase() : null;
      const environment = environmentRaw === "cloud" ? "cloud" : "on-premise";
      const dbName = mapping.dbName ? String(row[mapping.dbName] ?? "").trim() || null : null;
      const managedBy = mapping.managedBy ? String(row[mapping.managedBy] ?? "").trim() || null : null;
      const healthUrl = mapping.healthUrl ? String(row[mapping.healthUrl] ?? "").trim() || null : null;
      const remark = mapping.remark ? String(row[mapping.remark] ?? "").trim() || null : null;

      if (!dryRun) {
        await prisma.$transaction(async (tx) => {
          const s = await tx.service.create({
            data: {
              serviceName,
              serviceType,
              serverIp,
              port,
              domain,
              username,
              passwordEnc: password ? encryptSecret(password) : null,
              documentLink,
              project,
              version,
              environment,
              dbName,
              managedBy,
              healthUrl,
              remark,
            },
          });
          await tx.auditLog.create({
            data: {
              category: "data",
              action: "service.import",
              entity: "service",
              entityId: String(s.id),
              actorId: ctx.actorId ?? null,
              actorEmail: ctx.actorEmail ?? null,
              afterJson: JSON.stringify({ serviceName, serverIp, environment }),
              ip: ctx.ip ?? null,
            },
          });
        });
      }

      result.created++;
      result.errors.push({ row: rowNum, serviceName, status: "ok" });
    } catch (err: unknown) {
      result.errors.push({ row: rowNum, serviceName, status: "error", message: (err as Error).message });
    }
  }

  return result;
}

export async function exportServices(filters: Record<string, string | undefined>): Promise<Buffer> {
  const where = {
    deletedAt: null,
    ...(filters.q ? {
      OR: [
        { serviceName: { contains: filters.q } },
        { serverIp: { contains: filters.q } },
        { domain: { contains: filters.q } },
      ],
    } : {}),
  };

  const services = await prisma.service.findMany({
    where,
    orderBy: { id: "asc" },
  });

  const rows = services.map((s) => ({
    "SR N": s.id,
    "SERVICE NAME": s.serviceName,
    "SERVICE TYPE": s.serviceType ?? "",
    ENVIRONMENT: s.environment ?? "",
    "SERVER IP": s.serverIp ?? "",
    PORT: s.port ?? "",
    DOMAIN: s.domain ?? "",
    USERNAME: s.username ?? "",
    PROJECT: s.project ?? "",
    VERSION: s.version ?? "",
    "DB NAME": s.dbName ?? "",
    "MANAGED BY": s.managedBy ?? "",
    "HEALTH URL": s.healthUrl ?? "",
    "DOCUMENT LINK": s.documentLink ?? "",
    STATUS: s.lastStatus ?? "",
    "LAST CHECKED": s.lastCheckedAt?.toISOString() ?? "",
    "LATENCY MS": s.lastLatencyMs ?? "",
    REMARK: s.remark ?? "",
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Services");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buf;
}

export async function exportServicesJson(filters: Record<string, string | undefined>): Promise<string> {
  const where = {
    deletedAt: null,
    ...(filters.q ? {
      OR: [
        { serviceName: { contains: filters.q } },
        { serverIp: { contains: filters.q } },
        { domain: { contains: filters.q } },
      ],
    } : {}),
  };

  const services = await prisma.service.findMany({
    where,
    orderBy: { id: "asc" },
  });

  return JSON.stringify(services.map((s) => ({
    id: s.id,
    serviceName: s.serviceName,
    serviceType: s.serviceType,
    environment: s.environment,
    serverIp: s.serverIp,
    port: s.port,
    domain: s.domain,
    username: s.username,
    project: s.project,
    version: s.version,
    dbName: s.dbName,
    managedBy: s.managedBy,
    healthUrl: s.healthUrl,
    documentLink: s.documentLink,
    status: s.lastStatus,
    lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
    latencyMs: s.lastLatencyMs,
    remark: s.remark,
  })), null, 2);
}
