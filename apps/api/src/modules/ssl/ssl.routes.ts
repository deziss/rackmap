import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { SslStatusCreateInput, SslStatusUpdateInput, SslStatusListQuery } from "@inv/shared";
import { scanAllDomains, fetchSslCert } from "../health/ssl-checker.js";

const sslRoutes = new Hono();

// List SSL Statuses
sslRoutes.get("/", requireAuth(), zValidator("query", SslStatusListQuery), async (c) => {
  const query = c.req.valid("query");
  const { cursor, limit = 50, q, status } = query;

  const where = {
    ...(q ? { domain: { contains: q } } : {}),
    ...(status ? { status } : {}),
    ...(cursor ? { id: { lt: cursor } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.sslStatus.findMany({
      where,
      include: {
        server: { select: { id: true, hostname: true } },
        service: { select: { id: true, serviceName: true } }
      },
      orderBy: { id: "desc" },
      take: limit,
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
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }));

  const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
  return c.json({ items: dtos, nextCursor, total });
});

// Trigger Scan
sslRoutes.post("/scan", requireAuth(), async (c) => {
  // In a real app this might be a background job. We'll await it for now.
  await scanAllDomains(true);
  return c.json({ success: true, message: "Scan completed." });
});

// Scan a single specific domain (force)
sslRoutes.post("/:id/scan", requireAuth(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const ssl = await prisma.sslStatus.findUnique({ where: { id } });
  if (!ssl) return c.json({ error: "Not found" }, 404);

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
    return c.json({ error: e.message }, 500);
  }
});

// Create manual domain entry
sslRoutes.post("/", requireAuth(), zValidator("json", SslStatusCreateInput), async (c) => {
  const data = c.req.valid("json");
  
  const existing = await prisma.sslStatus.findUnique({ where: { domain: data.domain } });
  if (existing) return c.json({ error: "Domain already tracked" }, 409);

  const ssl = await prisma.sslStatus.create({
    data: {
      ...data,
      isManual: true,
    }
  });
  
  return c.json(ssl, 201);
});

// Update
sslRoutes.patch("/:id", requireAuth(), zValidator("json", SslStatusUpdateInput), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const data = c.req.valid("json");

  const ssl = await prisma.sslStatus.update({
    where: { id },
    data
  });

  return c.json(ssl);
});

// Delete
sslRoutes.delete("/:id", requireAuth(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  await prisma.sslStatus.delete({ where: { id } });
  return c.json({ success: true });
});

export { sslRoutes };
