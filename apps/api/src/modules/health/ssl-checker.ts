import tls from "tls";
import { prisma } from "../../db.js";
import { sendMail } from "../../lib/mail.js";
import { resolveTargetHost } from "../../lib/target-resolver.js";
import { emitAlert } from "../../services/alerting/emit.js";
import type { AlertSeverity } from "@inv/shared";

/** Days-remaining thresholds that each raise one ssl_expiring alert per certificate. */
export const SSL_ALERT_THRESHOLDS = [30, 14, 7, 1] as const;

/** The smallest threshold `daysRemaining` has reached, or null while more than 30 days remain. */
export function sslThresholdFor(daysRemaining: number): number | null {
  let hit: number | null = null;
  for (const t of SSL_ALERT_THRESHOLDS) if (daysRemaining <= t) hit = t;
  return hit;
}

export interface SslAlertDecision {
  /** New value for SslStatus.lastAlertThreshold. */
  nextThreshold: number | null;
  /** Raise ssl_expiring (trigger) for this threshold. */
  alert: boolean;
  /** The certificate was renewed past every threshold: close the incident. */
  resolved: boolean;
}

/**
 * Edge-triggered: alert once per threshold crossed (30 → 14 → 7 → 1) for the
 * current certificate. A renewed certificate shows up as daysRemaining jumping
 * above the last alerted threshold; that resets the state (and resolves the
 * incident if it is now past 30 days), so the next expiry alerts again.
 */
export function decideSslAlert(daysRemaining: number, lastAlertThreshold: number | null): SslAlertDecision {
  const crossed = sslThresholdFor(daysRemaining);
  let last = lastAlertThreshold;
  let resolved = false;
  if (last !== null && (crossed === null || crossed > last)) {
    resolved = crossed === null;
    last = null;
  }
  if (crossed !== null && (last === null || crossed < last)) {
    return { nextThreshold: crossed, alert: true, resolved: false };
  }
  return { nextThreshold: last, alert: false, resolved };
}

function sslSeverity(daysRemaining: number): AlertSeverity {
  if (daysRemaining <= 1) return "critical";
  if (daysRemaining <= 7) return "error";
  return "warning";
}

function connectAndGetCert(
  host: string,
  sni: string,
  timeoutMs: number = 5000
): Promise<{ validFrom: Date; validTo: Date; issuer: string; daysRemaining: number } | null> {
  const targetHost = resolveTargetHost(host);
  return new Promise((resolve, reject) => {
    let resolved = false;
    try {
      const socket = tls.connect(
        {
          host: targetHost,
          port: 443,
          servername: sni,
          rejectUnauthorized: false, // We want to parse expired certs too
          timeout: timeoutMs,
        },
        () => {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          resolved = true;
          if (!cert || !cert.valid_from || !cert.valid_to) {
            return resolve(null);
          }

          const validFrom = new Date(cert.valid_from);
          const validTo = new Date(cert.valid_to);
          const daysRemaining = Math.ceil(
            (validTo.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
          );

          const rawIssuer = cert.issuer?.O || cert.issuer?.CN || "Unknown Issuer";
          const issuer = Array.isArray(rawIssuer) ? rawIssuer.join(", ") : rawIssuer;

          resolve({ validFrom, validTo, issuer, daysRemaining });
        }
      );

      socket.on("error", (err) => {
        if (!resolved) {
          socket.destroy();
          reject(err);
        }
      });

      socket.on("timeout", () => {
        if (!resolved) {
          socket.destroy();
          reject(new Error("Timeout connecting to 443"));
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

export async function fetchSslCert(
  domain: string
): Promise<{ validFrom: Date; validTo: Date; issuer: string; daysRemaining: number } | null> {
  const trimmed = domain.trim();

  // If not a wildcard domain, probe directly
  if (!trimmed.startsWith("*.")) {
    return connectAndGetCert(trimmed, trimmed);
  }

  // Wildcard domain handling (e.g. *.example.com)
  const baseDomain = trimmed.slice(2).trim().toLowerCase();

  // 1. Gather candidate targets for this wildcard domain
  const candidates: { host: string; sni: string }[] = [];

  // Look for real existing subdomains in Database first
  try {
    const existingSubdomains = await prisma.sslStatus.findMany({
      where: {
        deletedAt: null,
        domain: {
          endsWith: `.${baseDomain}`,
          not: trimmed,
        },
      },
      select: { domain: true },
      take: 5,
    });
    for (const s of existingSubdomains) {
      if (s.domain && !s.domain.startsWith("*.")) {
        candidates.push({ host: s.domain, sni: s.domain });
      }
    }

    // Also check servers with matching domains
    const serversWithDomain = await prisma.server.findMany({
      where: {
        deletedAt: null,
        domain: { endsWith: baseDomain },
      },
      select: { domain: true, ip: true },
      take: 5,
    });
    for (const s of serversWithDomain) {
      if (s.domain && !s.domain.startsWith("*.")) {
        candidates.push({ host: s.domain, sni: s.domain });
      }
    }
  } catch {
    // Continue even if DB query fails
  }

  // Add standard domain candidates
  candidates.push({ host: baseDomain, sni: baseDomain });
  candidates.push({ host: `www.${baseDomain}`, sni: `www.${baseDomain}` });
  candidates.push({ host: `api.${baseDomain}`, sni: `api.${baseDomain}` });
  candidates.push({ host: `app.${baseDomain}`, sni: `app.${baseDomain}` });

  // Deduplicate candidate hosts
  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter((c) => {
    const key = c.host.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Try candidates in sequence
  let lastError: Error = new Error(`Could not connect to any host matching wildcard ${domain}`);
  for (const cand of uniqueCandidates) {
    try {
      const cert = await connectAndGetCert(cand.host, cand.sni, 4000);
      if (cert) {
        return cert;
      }
    } catch (err: any) {
      lastError = err;
    }
  }

  throw lastError;
}

export async function scanAllDomains(triggerEmail: boolean = false) {
  // Auto-discover domains from Server and Service tables
  const servers = await prisma.server.findMany({
    where: { domain: { not: null, notIn: [""] } },
    select: { id: true, domain: true }
  });
  
  const services = await prisma.service.findMany({
    where: { domain: { not: null, notIn: [""] } },
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
    } else if (!existing.deletedAt) {
      if (!existing.serverId && links.serverId) {
        await prisma.sslStatus.update({ where: { id: existing.id }, data: { serverId: links.serverId } });
      } else if (!existing.serviceId && links.serviceId) {
        await prisma.sslStatus.update({ where: { id: existing.id }, data: { serviceId: links.serviceId } });
      }
    }
  }

  // Scan all active domains in SslStatus
  const allStatuses = await prisma.sslStatus.findMany({ where: { deletedAt: null } });
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

      const decision = decideSslAlert(cert.daysRemaining, ssl.lastAlertThreshold);
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
          lastAlertThreshold: decision.nextThreshold,
        }
      });
      if (decision.alert || decision.resolved) {
        const expired = cert.daysRemaining <= 0;
        await emitAlert({
          type: "ssl_expiring",
          severity: decision.alert ? sslSeverity(cert.daysRemaining) : "info",
          action: decision.alert ? "trigger" : "resolve",
          dedupKey: `rackmap:ssl:${ssl.id}`,
          title: decision.alert
            ? expired
              ? `SSL certificate for ${ssl.domain} has expired`
              : `SSL certificate for ${ssl.domain} expires in ${cert.daysRemaining} day${cert.daysRemaining === 1 ? "" : "s"}`
            : `SSL certificate for ${ssl.domain} renewed`,
          summary: `Valid until ${cert.validTo.toUTCString()} (issuer: ${cert.issuer}).`,
          payload: {
            domain: ssl.domain,
            daysRemaining: cert.daysRemaining,
            validTo: cert.validTo.toISOString(),
            issuer: cert.issuer,
            threshold: decision.nextThreshold,
          },
          serverId: ssl.serverId,
          serviceId: ssl.serviceId,
        }).catch((err) => console.error(`[ssl] alert for ${ssl.domain} failed:`, (err as Error).message));
      }
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
          subject: "RackMap - SSL Expiry Alert",
          text
        });
      }
    } catch (e) {
      console.error("Failed to send SSL alert email", e);
    }
  }
}
