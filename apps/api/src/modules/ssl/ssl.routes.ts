import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { writeAudit } from "../../lib/audit.js";
import { SslStatusCreateInput, SslStatusUpdateInput, SslStatusListQuery } from "@inv/shared";
import { scanAllDomains, fetchSslCert } from "../health/ssl-checker.js";

const sslRoutes = new Hono().use(requireSession);

/** Audit context from the request. SSL mutations reach the network and the DB, so they are recorded. */
function auditCtx(c: any) {
  const user = c.get("user");
  return { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null };
}

/** Parses a positive integer route param, or null when malformed (NaN previously reached Prisma). */
function intParam(c: any, name: string): number | null {
  const n = Number.parseInt(c.req.param(name), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// List SSL Statuses
sslRoutes.get("/", zValidator("query", SslStatusListQuery), async (c) => {
  const query = c.req.valid("query");
  const { cursor, limit = 50, sortBy, sortDir, q, status, includeDeleted, includeWildcardSubdomains, page } = query;
  const pageNum = page ? Math.max(1, page) : undefined;

  const showDeleted = includeDeleted;

  const where: any = {
    ...(showDeleted ? {} : { deletedAt: null }),
    ...(status ? { status } : {}),
    ...(cursor && !sortBy ? { id: { lt: cursor } } : {}),
  };

  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { domain: { contains: term } },
      { team: { contains: term } },
      { project: { contains: term } },
      { issuer: { contains: term } },
      { server: { hostname: { contains: term } } },
      { service: { serviceName: { contains: term } } },
    ];
  }

  // 1. Detect active wildcard domains
  const activeWildcardEntries = await prisma.sslStatus.findMany({
    where: {
      deletedAt: null,
      domain: { startsWith: "*." },
    },
    select: { domain: true },
  });
  const activeWildcards = activeWildcardEntries.map((w) => w.domain.toLowerCase());
  const wildcardBases = activeWildcards.map((w) => w.slice(2));

  // 2. Omit specific subdomains covered by active wildcard domains (unless requested to include)
  let omittedSubdomainsCount = 0;
  if (!includeWildcardSubdomains && wildcardBases.length > 0) {
    const omitConditions: any[] = [];
    for (const base of wildcardBases) {
      omitConditions.push({
        domain: {
          endsWith: `.${base}`,
          not: `*.${base}`,
        },
      });
      omitConditions.push({
        domain: base,
      });
      omitConditions.push({
        domain: {
          contains: `.${base}:`,
        },
      });
      omitConditions.push({
        domain: {
          contains: `.${base}/`,
        },
      });
    }

    omittedSubdomainsCount = await prisma.sslStatus.count({
      where: {
        deletedAt: null,
        OR: omitConditions,
      },
    });

    if (!where.NOT) {
      where.NOT = omitConditions;
    } else if (Array.isArray(where.NOT)) {
      where.NOT.push(...omitConditions);
    } else {
      where.NOT = [where.NOT, ...omitConditions];
    }
  }

  const orderBy = sortBy ? { [sortBy]: sortDir || "asc" } : { id: "desc" };
  const skip = pageNum ? (pageNum - 1) * limit : sortBy ? (cursor || 0) : undefined;

  const [items, total] = await Promise.all([
    prisma.sslStatus.findMany({
      where,
      include: {
        server: { select: { id: true, hostname: true } },
        service: { select: { id: true, serviceName: true } }
      },
      orderBy: orderBy as any,
      take: limit,
      skip,
    }),
    prisma.sslStatus.count({ where }),
  ]);

  const dtos = items.map(item => ({
    id: item.id,
    domain: item.domain,
    team: item.team,
    project: item.project,
    server: item.server ? { id: item.server.id, name: item.server.hostname } : null,
    service: item.service ? { id: item.service.id, name: item.service.serviceName } : null,
    issuer: item.issuer,
    validFrom: item.validFrom?.toISOString() ?? null,
    validTo: item.validTo?.toISOString() ?? null,
    daysRemaining: item.daysRemaining,
    status: item.status,
    lastError: item.lastError,
    lastScannedAt: item.lastScannedAt?.toISOString() ?? null,
    isManual: item.isManual,
    deletedAt: item.deletedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }));

  const nextCursor = items.length === limit ? (sortBy ? (cursor || 0) + limit : (items[items.length - 1]?.id ?? null)) : null;
  return c.json({
    items: dtos,
    nextCursor,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limit) || 1,
    omittedSubdomainsCount,
    activeWildcards,
  });
});

// Trigger Scan
sslRoutes.post("/scan", requirePermission({ server: ["check"] }), async (c) => {
  // In a real app this might be a background job. We'll await it for now.
  await scanAllDomains(true);
  await writeAudit({ ctx: auditCtx(c), category: "data", action: "ssl.scan_all", entity: "SslStatus" });
  return c.json({ success: true, message: "Scan completed." });
});

// Scan a single specific domain (force)
sslRoutes.post("/:id/scan", requirePermission({ server: ["check"] }), async (c) => {
  const id = intParam(c, "id");
  if (id === null) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid id" } }, 400);
  const ssl = await prisma.sslStatus.findUnique({ where: { id } });
  if (!ssl) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);

  try {
    const cert = await fetchSslCert(ssl.domain);
    if (!cert) {
      await prisma.sslStatus.update({
        where: { id: ssl.id },
        data: { status: "error", lastError: "No cert found", lastScannedAt: new Date() }
      });
      return c.json({ error: "No cert found" }, 400);
    }

    let status = "valid";
    if (cert.daysRemaining <= 0) status = "expired";
    else if (cert.daysRemaining <= 30) status = "expiring_soon";

    const updated = await prisma.sslStatus.update({
      where: { id: ssl.id },
      data: {
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        issuer: cert.issuer,
        daysRemaining: cert.daysRemaining,
        status,
        lastError: null,
        lastScannedAt: new Date(),
      }
    });

    return c.json(updated);
  } catch (e: any) {
    await prisma.sslStatus.update({
      where: { id: ssl.id },
      data: { status: "error", lastError: e.message, lastScannedAt: new Date() }
    });
    return c.json({ error: { code: "SCAN_FAILED", message: "Certificate scan failed" } }, 500);
  }
});

// Create manual domain entry
sslRoutes.post("/", requirePermission({ server: ["create"] }), zValidator("json", SslStatusCreateInput), async (c) => {
  const data = c.req.valid("json");
  let normalizedDomain = data.domain.trim().toLowerCase();
  normalizedDomain = normalizedDomain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  
  const existing = await prisma.sslStatus.findUnique({ where: { domain: normalizedDomain } });
  if (existing) {
    if (existing.deletedAt) {
      const restored = await prisma.sslStatus.update({
        where: { id: existing.id },
        data: { ...data, domain: normalizedDomain, deletedAt: null, isManual: true }
      });
      await writeAudit({
        ctx: auditCtx(c), category: "data", action: "ssl.restore", entity: "SslStatus",
        entityId: String(existing.id), before: existing, after: restored,
      });
      return c.json(restored, 200);
    }
    return c.json({ error: { code: "CONFLICT", message: "Domain already tracked" } }, 409);
  }

  const ssl = await prisma.sslStatus.create({
    data: {
      ...data,
      domain: normalizedDomain,
      isManual: true,
    }
  });

  await writeAudit({
    ctx: auditCtx(c), category: "data", action: "ssl.create", entity: "SslStatus",
    entityId: String(ssl.id), after: ssl,
  });

  // Automatically attempt initial scan
  try {
    const cert = await fetchSslCert(ssl.domain);
    if (cert) {
      let status = "valid";
      if (cert.daysRemaining <= 0) status = "expired";
      else if (cert.daysRemaining <= 30) status = "expiring_soon";

      const updated = await prisma.sslStatus.update({
        where: { id: ssl.id },
        data: {
          validFrom: cert.validFrom,
          validTo: cert.validTo,
          issuer: cert.issuer,
          daysRemaining: cert.daysRemaining,
          status,
          lastError: null,
          lastScannedAt: new Date(),
        }
      });
      return c.json(updated, 201);
    }
  } catch (e: any) {
    await prisma.sslStatus.update({
      where: { id: ssl.id },
      data: { status: "error", lastError: e.message, lastScannedAt: new Date() }
    });
  }
  
  return c.json(ssl, 201);
});

// Update
sslRoutes.patch("/:id", requirePermission({ server: ["update"] }), zValidator("json", SslStatusUpdateInput), async (c) => {
  const id = intParam(c, "id");
  if (id === null) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid id" } }, 400);
  const data = c.req.valid("json");

  const before = await prisma.sslStatus.findUnique({ where: { id } });
  if (!before) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);

  const ssl = await prisma.sslStatus.update({
    where: { id },
    data
  });

  await writeAudit({
    ctx: auditCtx(c), category: "data", action: "ssl.update", entity: "SslStatus",
    entityId: String(id), before, after: ssl,
  });

  return c.json(ssl);
});

// Delete (soft delete)
sslRoutes.delete("/:id", requirePermission({ server: ["delete"] }), async (c) => {
  const id = intParam(c, "id");
  if (id === null) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid id" } }, 400);
  const before = await prisma.sslStatus.findUnique({ where: { id } });
  if (!before) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  await prisma.sslStatus.update({ where: { id }, data: { deletedAt: new Date() } });
  await writeAudit({
    ctx: auditCtx(c), category: "data", action: "ssl.delete", entity: "SslStatus",
    entityId: String(id), before,
  });
  return c.json({ success: true });
});

// Restore
sslRoutes.post("/:id/restore", requirePermission({ server: ["restore"] }), async (c) => {
  const id = intParam(c, "id");
  if (id === null) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid id" } }, 400);
  await prisma.sslStatus.update({ where: { id }, data: { deletedAt: null } });
  await writeAudit({
    ctx: auditCtx(c), category: "data", action: "ssl.restore", entity: "SslStatus", entityId: String(id),
  });
  return c.json({ success: true });
});

export { sslRoutes };
