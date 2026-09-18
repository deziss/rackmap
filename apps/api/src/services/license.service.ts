import os from "node:os";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../lib/errors.js";
import {
  generateHardwareFingerprint,
  verifyLicenseToken,
  subMatches,
} from "./licencia-crypto.js";
import type {
  LicenseTier,
  LicenseFeature,
  LicenseStatusResponse,
} from "@inv/shared";

const FREE_MAX_SERVERS = 10;

const FREE_FEATURES: Record<LicenseFeature, boolean> = {
  hardware_discovery: false,
  atop_history: false,
  remote_os_users: false,
  auto_update: false,
  multi_channel_alerts: false,
  unlimited_servers: false,
};

const PRO_FEATURES: Record<LicenseFeature, boolean> = {
  hardware_discovery: true,
  atop_history: true,
  remote_os_users: true,
  auto_update: true,
  multi_channel_alerts: true,
  unlimited_servers: false,
};

const ENTERPRISE_FEATURES: Record<LicenseFeature, boolean> = {
  hardware_discovery: true,
  atop_history: true,
  remote_os_users: true,
  auto_update: true,
  multi_channel_alerts: true,
  unlimited_servers: true,
};

/** Get the current license status and active entitlements */
export async function getLicenseStatus(): Promise<LicenseStatusResponse> {
  const serverCount = await prisma.server.count({ where: { deletedAt: null } });
  const hwId = generateHardwareFingerprint();

  const record = await prisma.systemLicense.findFirst({ where: { id: 1 } });
  if (!record || !record.key || record.tier === "free") {
    return {
      tier: "free",
      planName: "Free Community Edition",
      valid: true,
      expiresAt: null,
      serverCount,
      maxServers: FREE_MAX_SERVERS,
      canAddServer: serverCount < FREE_MAX_SERVERS,
      features: FREE_FEATURES,
      licenseKeyMasked: null,
      isOffline: true,
      hardwareId: hwId,
      message: "Operating on Free Community Edition (limit 10 servers).",
    };
  }

  // Check expiration
  const now = new Date();
  if (record.expiresAt && record.expiresAt < now) {
    return {
      tier: "free",
      planName: "Free Community Edition (License Expired)",
      valid: false,
      expiresAt: record.expiresAt.toISOString(),
      serverCount,
      maxServers: FREE_MAX_SERVERS,
      canAddServer: serverCount < FREE_MAX_SERVERS,
      features: FREE_FEATURES,
      licenseKeyMasked: maskKey(record.key),
      isOffline: true,
      hardwareId: hwId,
      message: "Your subscription has expired. Operating on Free Community limits.",
    };
  }

  const tier = (record.tier as LicenseTier) || "pro";
  let features = tier === "enterprise" ? ENTERPRISE_FEATURES : PRO_FEATURES;

  // Merge custom featuresJson if present
  if (record.featuresJson) {
    try {
      const parsed = JSON.parse(record.featuresJson);
      features = { ...features, ...parsed };
    } catch {
      // ignore
    }
  }

  const maxServers = record.maxServers;
  const canAddServer = maxServers === -1 || serverCount < maxServers;

  return {
    tier,
    planName: tier === "enterprise" ? "RackMap Enterprise" : "RackMap Pro",
    valid: true,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    serverCount,
    maxServers,
    canAddServer,
    features,
    licenseKeyMasked: maskKey(record.key),
    isOffline: !env.LICENCIA_URL,
    hardwareId: hwId,
    message: `Active ${tier.toUpperCase()} license.`,
  };
}

/** Activate a Licencia key or offline lease token */
export async function activateLicense(input: {
  key: string;
  offlineToken?: string;
}): Promise<LicenseStatusResponse> {
  const key = input.key.trim();
  const offlineToken = input.offlineToken?.trim();
  const hwId = generateHardwareFingerprint();

  // 1. Offline Ed25519 token verification if token provided or key is JWT-shaped
  const tokenToVerify = offlineToken || (key.includes(".") ? key : null);
  if (tokenToVerify && env.LICENCIA_PUBLIC_KEY) {
    try {
      const verified = verifyLicenseToken(tokenToVerify, env.LICENCIA_PUBLIC_KEY);
      const ent = verified.payload.ent || {};
      const tier: LicenseTier = ent.tier === "enterprise" ? "enterprise" : "pro";
      const maxServers = ent.limits?.max_servers ?? (tier === "enterprise" ? -1 : 100);
      const expiresAt = verified.payload.exp ? new Date(verified.payload.exp * 1000) : null;

      await prisma.systemLicense.upsert({
        where: { id: 1 },
        update: {
          key: key.includes(".") ? "OFFLINE-TOKEN" : key,
          leaseToken: tokenToVerify,
          tier,
          featuresJson: JSON.stringify(ent.features || {}),
          maxServers,
          expiresAt,
          cachedAt: new Date(),
        },
        create: {
          id: 1,
          key: key.includes(".") ? "OFFLINE-TOKEN" : key,
          leaseToken: tokenToVerify,
          tier,
          featuresJson: JSON.stringify(ent.features || {}),
          maxServers,
          expiresAt,
          cachedAt: new Date(),
        },
      });

      return getLicenseStatus();
    } catch (e: any) {
      throw new AppError("VALIDATION_ERROR", `Offline verification failed: ${e.message}`, 400);
    }
  }

  // 2. Online validation against Licencia server if LICENCIA_URL configured
  if (env.LICENCIA_URL) {
    try {
      const res = await fetch(`${env.LICENCIA_URL.replace(/\/$/, "")}/api/v1/licenses/validate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.LICENCIA_API_KEY ? { "x-api-key": env.LICENCIA_API_KEY } : {}),
        },
        body: JSON.stringify({
          key,
          hardwareId: hwId,
          deviceName: os.hostname(),
          os: process.platform,
          appVersion: "0.5.0",
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Licencia API responded with HTTP ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as any;
      if (!data.valid) {
        throw new Error(data.message || "License key is invalid or suspended");
      }

      const ent = data.entitlements || {};
      const tier: LicenseTier = ent.tier === "enterprise" ? "enterprise" : "pro";
      const maxServers = ent.limits?.max_servers ?? (tier === "enterprise" ? -1 : 100);
      const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

      await prisma.systemLicense.upsert({
        where: { id: 1 },
        update: {
          key,
          leaseToken: data.leaseToken || null,
          tier,
          featuresJson: JSON.stringify(ent.features || {}),
          maxServers,
          expiresAt,
          cachedAt: new Date(),
        },
        create: {
          id: 1,
          key,
          leaseToken: data.leaseToken || null,
          tier,
          featuresJson: JSON.stringify(ent.features || {}),
          maxServers,
          expiresAt,
          cachedAt: new Date(),
        },
      });

      return getLicenseStatus();
    } catch (e: any) {
      if (e.message?.includes("fetch failed") || e.message?.includes("ECONNREFUSED") || e.message?.includes("ENOTFOUND")) {
        console.warn(`[Licencia] Server ${env.LICENCIA_URL} unreachable (${e.message}). Falling back to offline key activation.`);
      } else {
        throw new AppError("VALIDATION_ERROR", `Failed to validate license with Licencia: ${e.message}`, 400);
      }
    }
  }

  // 3. Fallback / direct license key activation (for local demo or test keys)
  const isEnterprise = key.toUpperCase().includes("ENT") || key.toUpperCase().includes("ENTERPRISE");
  const tier: LicenseTier = isEnterprise ? "enterprise" : "pro";
  const maxServers = isEnterprise ? -1 : 100;
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

  await prisma.systemLicense.upsert({
    where: { id: 1 },
    update: {
      key,
      leaseToken: null,
      tier,
      featuresJson: JSON.stringify(isEnterprise ? ENTERPRISE_FEATURES : PRO_FEATURES),
      maxServers,
      expiresAt,
      cachedAt: new Date(),
    },
    create: {
      id: 1,
      key,
      leaseToken: null,
      tier,
      featuresJson: JSON.stringify(isEnterprise ? ENTERPRISE_FEATURES : PRO_FEATURES),
      maxServers,
      expiresAt,
      cachedAt: new Date(),
    },
  });

  return getLicenseStatus();
}

/** Deactivate current license and return to Free tier */
export async function deactivateLicense(): Promise<LicenseStatusResponse> {
  const current = await prisma.systemLicense.findFirst({ where: { id: 1 } });
  if (current?.key && env.LICENCIA_URL) {
    try {
      await fetch(`${env.LICENCIA_URL.replace(/\/$/, "")}/api/v1/licenses/deactivate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.LICENCIA_API_KEY ? { "x-api-key": env.LICENCIA_API_KEY } : {}),
        },
        body: JSON.stringify({
          key: current.key,
          hardwareId: generateHardwareFingerprint(),
        }),
      });
    } catch {
      // Best-effort remote deactivation
    }
  }

  await prisma.systemLicense.upsert({
    where: { id: 1 },
    update: {
      key: null,
      leaseToken: null,
      tier: "free",
      featuresJson: "{}",
      maxServers: FREE_MAX_SERVERS,
      expiresAt: null,
      cachedAt: new Date(),
    },
    create: {
      id: 1,
      key: null,
      leaseToken: null,
      tier: "free",
      featuresJson: "{}",
      maxServers: FREE_MAX_SERVERS,
      expiresAt: null,
      cachedAt: new Date(),
    },
  });

  return getLicenseStatus();
}

/** Assert that server capacity limit has not been exceeded */
export async function assertCanAddServer(): Promise<void> {
  const status = await getLicenseStatus();
  if (!status.canAddServer) {
    throw new AppError(
      "FORBIDDEN",
      `Server limit reached (${status.serverCount}/${status.maxServers}). Upgrade to RackMap Pro or Enterprise to manage additional servers.`,
      403
    );
  }
}

/** Assert that a specific Pro/Enterprise feature is entitled */
export async function assertFeatureEnabled(feature: LicenseFeature): Promise<void> {
  const status = await getLicenseStatus();
  if (!status.features[feature]) {
    const featureNames: Record<LicenseFeature, string> = {
      hardware_discovery: "Hardware Auto-Discovery via SSH",
      atop_history: "ATOP Historical Performance & Spikes Timeline",
      remote_os_users: "Remote OS User & Sudoers Management",
      auto_update: "Automated System Updates (Unattended-Upgrades)",
      multi_channel_alerts: "Multi-Channel Alert Dispatching",
      unlimited_servers: "Unlimited Servers Fleet Management",
    };
    const humanName = featureNames[feature] || feature;
    throw new AppError(
      "FORBIDDEN",
      `Feature "${humanName}" requires an active Pro or Enterprise subscription. Please upgrade your license in Admin Settings.`,
      403
    );
  }
}

/** Mask a license key: LIC-XXXX...XXXX */
function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

/** Auto-initialize license if LICENCIA_LICENSE_KEY is in .env */
export async function autoInitLicenseFromEnv(): Promise<void> {
  if (!env.LICENCIA_LICENSE_KEY) return;
  const existing = await prisma.systemLicense.findFirst({ where: { id: 1 } });
  if (!existing || !existing.key || existing.tier === "free") {
    console.log("[Licencia] Activating license key from LICENCIA_LICENSE_KEY environment variable...");
    try {
      await activateLicense({ key: env.LICENCIA_LICENSE_KEY });
      console.log("[Licencia] Successfully activated license from environment variable.");
    } catch (e: any) {
      console.warn(`[Licencia] Warning: Could not activate license from env: ${e.message}`);
    }
  }
}
