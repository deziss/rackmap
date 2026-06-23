import tls from "tls";
import { prisma } from "../../db.js";
import { sendMail } from "../../lib/mail.js"; // Assuming a mail.ts exists or we will create one

export async function fetchSslCert(domain: string): Promise<{ validFrom: Date; validTo: Date; issuer: string; daysRemaining: number } | null> {
  return new Promise((resolve, reject) => {
    try {
      const socket = tls.connect({
        host: domain,
        port: 443,
        servername: domain,
        rejectUnauthorized: false, // We want to parse expired certs too
        timeout: 5000,
      }, () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_from || !cert.valid_to) {
          socket.destroy();
          return resolve(null);
        }
        
        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const daysRemaining = Math.ceil((validTo.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
        
        // Issuer can be cert.issuer.O or cert.issuer.CN
        const issuer = cert.issuer?.O || cert.issuer?.CN || "Unknown Issuer";

        socket.destroy();
        resolve({ validFrom, validTo, issuer, daysRemaining });
      });

      socket.on("error", (err) => {
        socket.destroy();
        reject(err);
      });

      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("Timeout connecting to 443"));
      });
    } catch (e) {
      reject(e);
    }
  });
}

export async function scanAllDomains(triggerEmail: boolean = false) {
  // Auto-discover domains from Server and Service tables
  const servers = await prisma.server.findMany({
    where: { domain: { not: null, not: "" } },
    select: { id: true, domain: true }
  });
  
  const services = await prisma.service.findMany({
    where: { domain: { not: null, not: "" } },
    select: { id: true, domain: true }
  });

  // Extract unique domains
  const autoDomains = new Map<string, { serverId?: number; serviceId?: number }>();
  for (const s of servers) {
    if (s.domain) autoDomains.set(s.domain, { serverId: s.id });
  }
  for (const s of services) {
    if (s.domain) autoDomains.set(s.domain, { serviceId: s.id });
  }

  // Ensure all auto-discovered domains exist in SslStatus
  for (const [domain, links] of autoDomains.entries()) {
    const existing = await prisma.sslStatus.findUnique({ where: { domain } });
    if (!existing) {
      await prisma.sslStatus.create({
        data: {
          domain,
          serverId: links.serverId,
          serviceId: links.serviceId,
          isManual: false,
        }
      });
    } else if (!existing.serverId && links.serverId) {
      await prisma.sslStatus.update({ where: { id: existing.id }, data: { serverId: links.serverId } });
    } else if (!existing.serviceId && links.serviceId) {
      await prisma.sslStatus.update({ where: { id: existing.id }, data: { serviceId: links.serviceId } });
    }
  }

  // Scan all domains in SslStatus
  const allStatuses = await prisma.sslStatus.findMany();
  const expiringSoon: any[] = [];
  const expiredList: any[] = [];

  for (const ssl of allStatuses) {
    try {
      const cert = await fetchSslCert(ssl.domain);
      if (!cert) {
        await prisma.sslStatus.update({
          where: { id: ssl.id },
          data: { status: "error", lastError: "No cert found", lastScannedAt: new Date() }
        });
        continue;
      }

      let status = "valid";
      if (cert.daysRemaining <= 0) {
        status = "expired";
        expiredList.push({ domain: ssl.domain, daysRemaining: cert.daysRemaining });
      } else if (cert.daysRemaining <= 30) {
        status = "expiring_soon";
        expiringSoon.push({ domain: ssl.domain, daysRemaining: cert.daysRemaining });
      }

      await prisma.sslStatus.update({
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
    } catch (e: any) {
      await prisma.sslStatus.update({
        where: { id: ssl.id },
        data: { status: "error", lastError: e.message, lastScannedAt: new Date() }
      });
    }
  }

  // Optionally send email
  if (triggerEmail && (expiringSoon.length > 0 || expiredList.length > 0)) {
    try {
      const { SEED_ADMIN_EMAIL } = process.env;
      if (SEED_ADMIN_EMAIL) {
        const text = [
          "SSL Expiry Report:",
          "",
          expiredList.length > 0 ? "EXPIRED DOMAINS:\n" + expiredList.map(d => `- ${d.domain}`).join("\n") : "",
          expiringSoon.length > 0 ? "\nEXPIRING SOON:\n" + expiringSoon.map(d => `- ${d.domain} (${d.daysRemaining} days left)`).join("\n") : "",
        ].filter(Boolean).join("\n");
        
        await sendMail({
          to: SEED_ADMIN_EMAIL,
          subject: "CloudScope - SSL Expiry Alert",
          text
        });
      }
    } catch (e) {
      console.error("Failed to send SSL alert email", e);
    }
  }
}
