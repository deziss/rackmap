import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import { prisma } from "../db.js";
import { setOutboundPolicyForTests, type OutboundPolicy } from "../lib/outbound-http.js";
import { invalidateAlertLicenseCache } from "../services/alerting/license.js";
import { resetAlertRateBuckets } from "../services/alerting/dispatcher.js";
import { sealChannelSecret, secretHintFor } from "../services/alerting/channel-secret.js";
import type { ChannelSecret } from "../services/alerting/types.js";
import type { AlertChannelType } from "@inv/shared";

/**
 * Shared fixtures for the alert-channel test files. Nothing here talks to a
 * real third party: receivers are local node:http servers and DNS answers are
 * injected through the outbound policy.
 */

export interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface Receiver {
  url: string;
  port: number;
  received: Received[];
  /** Decide the reply for the n-th request (0-based). Default: 200 "ok". */
  reply: (req: Received, n: number) => Reply;
  close(): Promise<void>;
}

export async function startReceiver(reply?: (req: Received, n: number) => Reply): Promise<Receiver> {
  const received: Received[] = [];
  const r: Partial<Receiver> = { received, reply: reply ?? (() => ({ status: 200, body: "ok" })) };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: Received = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(rec);
      const out = r.reply!(rec, received.length - 1);
      res.writeHead(out.status, out.headers ?? { "content-type": "text/plain" });
      res.end(out.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  r.port = port;
  r.url = `http://127.0.0.1:${port}`;
  r.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return r as Receiver;
}

/** A policy that lets tests reach the loopback receivers, with DNS faked to loopback. */
export const LOCAL_POLICY: OutboundPolicy = {
  allowPrivate: true,
  allowHttp: true,
  allowlist: [],
  lookup: async () => [{ address: "127.0.0.1", family: 4 }],
};

export function useOutboundPolicy(policy: OutboundPolicy | null): void {
  setOutboundPolicyForTests(policy);
}

let savedLicense: Awaited<ReturnType<typeof prisma.systemLicense.findFirst>> | undefined;

/** Switch the system license tier (remembers the original row for restoreLicense). */
export async function setLicenseTier(tier: "free" | "pro"): Promise<void> {
  if (savedLicense === undefined) savedLicense = await prisma.systemLicense.findFirst({ where: { id: 1 } });
  if (tier === "free") {
    await prisma.systemLicense.deleteMany({ where: { id: 1 } });
  } else {
    const data = { key: "LIC-TEST-ALERTS-PRO-0001", tier: "pro", maxServers: -1, featuresJson: "{}", expiresAt: null };
    await prisma.systemLicense.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  }
  invalidateAlertLicenseCache();
}

export async function restoreLicense(): Promise<void> {
  if (savedLicense === undefined) return;
  await prisma.systemLicense.deleteMany({ where: { id: 1 } });
  if (savedLicense) {
    const { updatedAt: _u, ...rest } = savedLicense;
    await prisma.systemLicense.create({ data: rest });
  }
  savedLicense = undefined;
  invalidateAlertLicenseCache();
}

/** Wipe every alert row so each test starts from an empty outbox. */
export async function resetAlerts(): Promise<void> {
  await prisma.alertDelivery.deleteMany({});
  await prisma.alertEvent.deleteMany({});
  await prisma.alertChannel.deleteMany({});
  resetAlertRateBuckets();
  invalidateAlertLicenseCache();
}

/** Insert a channel row directly (bypasses route validation and licensing). */
export async function insertChannel(opts: {
  name?: string;
  type: AlertChannelType;
  secret?: ChannelSecret;
  config?: Record<string, unknown>;
  events?: string[];
  filters?: Record<string, unknown> | null;
  managedBy?: "ui" | "env";
  envKey?: string;
  enabled?: boolean;
}) {
  const secret = opts.secret ?? {};
  return prisma.alertChannel.create({
    data: {
      name: opts.name ?? `${opts.type} test`,
      type: opts.type,
      enabled: opts.enabled ?? true,
      managedBy: opts.managedBy ?? "ui",
      envKey: opts.envKey ?? null,
      config: (opts.config ?? {}) as object,
      secretEnc: sealChannelSecret(secret),
      secretHint: secretHintFor(opts.type, secret),
      events: opts.events ?? ["server_down", "server_up", "test"],
      ...(opts.filters ? { filters: opts.filters as object } : {}),
    },
  });
}

export function jsonHeaders(cookie?: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) };
}
