import { env } from "../env.js";
import { prisma } from "../db.js";
import { escapeEmailHtml as esc, sendEmail } from "./email.service.js";
import { emitAlert } from "./alerting/emit.js";
import type { LegacyPayload } from "./alerting/formatters/webhook.js";
import type { NotificationPreference } from "@prisma/client";

/**
 * Notification adapters. The call sites (status/service-status flips, metric
 * alerts, access requests, sign-up) keep these signatures; underneath, channel
 * delivery goes through the alert outbox (emitAlert → dispatcher), and the
 * per-user email preferences are sent directly as before.
 *
 * NOTIFY_WEBHOOK_URL / NOTIFY_TELEGRAM_* are no longer posted to from here:
 * syncEnvAlertChannels() mirrors them into env-managed channels at boot, the
 * webhook one in `legacy_v1` format, which reproduces the old bodies exactly
 * from the `payload.legacy` stashed below.
 */

interface FlipEvent {
  serverId?: number;
  serviceId?: number;
  type?: "server" | "service";
  hostname: string;
  ip: string;
  port: number;
  from: string;
  to: string;
}

export interface AccessRequestEvent {
  requestId: number;
  status: "approved" | "rejected";
  type: "ssh" | "password_reveal" | "service_password_reveal";
  requesterEmail: string;
  hostname: string;
  adminNote?: string | null;
  expiresAt?: Date | null;
}

export interface AccessRequestCreatedEvent {
  requestId: number;
  type: "ssh" | "password_reveal" | "service_password_reveal";
  requesterEmail: string;
  hostname: string;
  note?: string | null;
  serverId?: number;
  serviceId?: number;
}

type MetricAlertType = "highCpu" | "ramFull" | "diskFull" | "diskUnmounted" | "gpuCountChanged";

async function getOptedInEmails(preferenceField: keyof NotificationPreference, adminOnly = false) {
  const whereClause: any = {
    notificationPreference: {
      [preferenceField]: true,
    },
  };
  if (adminOnly) {
    whereClause.role = "admin";
  }

  const users = await prisma.user.findMany({
    where: whereClause,
    select: { email: true, id: true },
  });
  return users.map(u => u.email);
}

/** How many users receive server up/down email through their notification preferences. */
export async function countFlipEmailRecipients(): Promise<number> {
  return prisma.user.count({ where: { notificationPreference: { serverUpDown: true } } });
}

async function logAuditNotification(action: string, entity: string, entityId: string, details: any) {
  try {
    await prisma.auditLog.create({
      data: {
        category: "notification",
        action,
        entity,
        entityId,
        actorEmail: "system",
        afterJson: JSON.stringify(details),
      },
    });
  } catch (err) {
    console.error("[notify] failed to log audit:", err);
  }
}

/** Never let an alert-outbox problem break the caller (a probe sweep, a request). */
async function safeEmit(e: Parameters<typeof emitAlert>[0]): Promise<void> {
  try {
    await emitAlert(e);
  } catch (err) {
    console.error(`[notify] emitAlert(${e.type}) failed:`, (err as Error).message);
  }
}

const ACCESS_TYPE_LABELS: Record<AccessRequestEvent["type"], string> = {
  ssh: "SSH Terminal",
  password_reveal: "Password Reveal",
  service_password_reveal: "Service Password Reveal",
};

export async function notifyFlip(event: FlipEvent): Promise<void> {
  const isService = event.type === "service";
  const up = event.to === "up";
  const typeLabel = isService ? "Service" : "Server";
  const legacy: LegacyPayload = {
    kind: "status_flip",
    type: event.type ?? "server",
    serverId: event.serverId,
    serviceId: event.serviceId,
    hostname: event.hostname,
    ip: event.ip,
    port: event.port,
    from: event.from,
    to: event.to,
  };
  const entityId = isService ? event.serviceId : event.serverId;

  await safeEmit({
    type: isService ? (up ? "service_up" : "service_down") : up ? "server_up" : "server_down",
    severity: up ? "info" : "critical",
    action: up ? "resolve" : "trigger",
    ...(entityId !== undefined ? { dedupKey: `rackmap:${isService ? "service" : "server"}:${entityId}` } : {}),
    title: `${typeLabel} ${event.hostname} is ${up ? "UP" : "DOWN"}`,
    summary: `${event.hostname} (${event.ip}:${event.port}) status changed from ${event.from} to ${event.to}.`,
    payload: { hostname: event.hostname, ip: event.ip, port: event.port, from: event.from, to: event.to, legacy },
    serverId: event.serverId ?? null,
    serviceId: event.serviceId ?? null,
  });

  const emails = await getOptedInEmails("serverUpDown");
  if (emails.length > 0) {
    const emoji = up ? "✅" : "🔴";
    await sendEmail({
      to: emails,
      subject: `[RackMap] Server ${event.hostname} is ${event.to.toUpperCase()}`.replace(/[\r\n]+/g, " "),
      html: `<p>${emoji} The server <b>${esc(event.hostname)}</b> (${esc(event.ip)}:${event.port}) status changed from <b>${esc(event.from)}</b> to <b>${esc(event.to)}</b>.</p>`,
    });
    await logAuditNotification("email_sent", "Server", String(event.serverId), { type: "serverUpDown", count: emails.length });
  }
}

/** An access request was approved or rejected. */
export async function notifyAccessRequest(ev: AccessRequestEvent): Promise<void> {
  const legacy: LegacyPayload = {
    kind: "access_request",
    requestId: ev.requestId,
    status: ev.status,
    type: ev.type,
    requesterEmail: ev.requesterEmail,
    hostname: ev.hostname,
    adminNote: ev.adminNote ?? null,
    expiresAt: ev.expiresAt?.toISOString() ?? null,
  };
  const note = ev.adminNote ? `\nNote: ${ev.adminNote}` : "";
  const expiry = ev.expiresAt ? `\nExpires: ${ev.expiresAt.toUTCString()}` : "";
  await safeEmit({
    type: "access_request",
    severity: "info",
    action: "info",
    title: `Access request ${ev.status}: ${ev.hostname}`,
    summary: `User: ${ev.requesterEmail}\nServer: ${ev.hostname}\nType: ${ACCESS_TYPE_LABELS[ev.type] ?? ev.type}${note}${expiry}`,
    payload: { requestId: ev.requestId, status: ev.status, hostname: ev.hostname, requesterEmail: ev.requesterEmail, legacy },
  });
}

/** A new access request is waiting for an admin (so admins hear about it without polling the badge). */
export async function notifyAccessRequestCreated(ev: AccessRequestCreatedEvent): Promise<void> {
  const legacy: LegacyPayload = {
    kind: "access_request",
    requestId: ev.requestId,
    status: "pending",
    type: ev.type,
    requesterEmail: ev.requesterEmail,
    hostname: ev.hostname,
    adminNote: null,
    expiresAt: null,
  };
  await safeEmit({
    type: "access_request",
    severity: "info",
    action: "info",
    title: `Access requested: ${ev.hostname}`,
    summary: `${ev.requesterEmail} requested ${ACCESS_TYPE_LABELS[ev.type] ?? ev.type} access to ${ev.hostname}.${ev.note ? `\nNote: ${ev.note}` : ""}`,
    payload: { requestId: ev.requestId, status: "pending", hostname: ev.hostname, requesterEmail: ev.requesterEmail, legacy },
    serverId: ev.serverId ?? null,
    serviceId: ev.serviceId ?? null,
  });
}

export async function notifyNewServer(server: { id: number; hostname: string; ip: string }): Promise<void> {
  const emails = await getOptedInEmails("newServerAdded");
  if (emails.length > 0) {
    await sendEmail({
      to: emails,
      subject: `[RackMap] New Server Added: ${server.hostname}`.replace(/[\r\n]+/g, " "),
      html: `<p>A new server has been added to RackMap.</p><p><b>Hostname:</b> ${esc(server.hostname)}<br/><b>IP:</b> ${esc(server.ip)}</p>`,
    });
    await logAuditNotification("email_sent", "Server", String(server.id), { type: "newServerAdded", count: emails.length });
  }
}

const METRIC_LABELS: Record<MetricAlertType, string> = {
  highCpu: "High CPU load",
  ramFull: "RAM almost full",
  diskFull: "Disk almost full",
  diskUnmounted: "Disk unmounted",
  gpuCountChanged: "GPU count changed",
};

/** Stateful metrics have a matching resolve; the one-shot ones do not. */
const STATEFUL_METRICS: readonly MetricAlertType[] = ["highCpu", "ramFull", "diskFull"];

export async function notifyMetricAlert(
  type: MetricAlertType,
  server: { id: number; hostname: string },
  details: string
): Promise<void> {
  const stateful = STATEFUL_METRICS.includes(type);
  await safeEmit({
    type: "metric_alert",
    severity: type === "diskFull" || type === "diskUnmounted" ? "error" : "warning",
    action: stateful ? "trigger" : "info",
    ...(stateful ? { dedupKey: `rackmap:metric:${server.id}:${type}` } : {}),
    title: `${METRIC_LABELS[type]} on ${server.hostname}`,
    summary: details,
    payload: { hostname: server.hostname, metric: type, details },
    serverId: server.id,
  });

  const emails = await getOptedInEmails(type);
  if (emails.length > 0) {
    await sendEmail({
      to: emails,
      subject: `[RackMap] Alert for ${server.hostname}: ${type}`.replace(/[\r\n]+/g, " "),
      html: `<p><b>Alert on server ${esc(server.hostname)}</b></p><p>${esc(details)}</p>`,
    });
    await logAuditNotification("email_sent", "Server", String(server.id), { type, details, count: emails.length });
  }
}

/** Falling edge of a stateful metric alert: closes the incident the trigger opened. Channels only. */
export async function notifyMetricResolved(
  type: "highCpu" | "ramFull" | "diskFull",
  server: { id: number; hostname: string },
  details: string,
): Promise<void> {
  await safeEmit({
    type: "metric_alert",
    severity: "info",
    action: "resolve",
    dedupKey: `rackmap:metric:${server.id}:${type}`,
    title: `${METRIC_LABELS[type]} on ${server.hostname}`,
    summary: details,
    payload: { hostname: server.hostname, metric: type, details },
    serverId: server.id,
  });
}

export async function notifyUserRegistered(user: { id: string; email: string; name: string }): Promise<void> {
  // 1. Notify admins who opted in
  const adminEmails = await getOptedInEmails("userRegistered", true);
  if (adminEmails.length > 0) {
    await sendEmail({
      to: adminEmails,
      subject: `[RackMap] New User Registered: ${user.name}`.replace(/[\r\n]+/g, " "),
      html: `<p>A new user just registered.</p><p><b>Name:</b> ${esc(user.name)}<br/><b>Email:</b> ${esc(user.email)}</p>`,
    });
    await logAuditNotification("email_sent", "User", user.id, { type: "userRegisteredAdminAlert", count: adminEmails.length });
  }

  // 2. Send welcome email to the user
  if (env.SMTP_HOST) {
    await sendEmail({
      to: user.email,
      subject: `Welcome to RackMap`,
      html: `<p>Hi ${esc(user.name)},</p><p>Welcome to RackMap! Your account has been successfully created.</p>`,
    });
    await logAuditNotification("email_sent", "User", user.id, { type: "userWelcome" });
  }
}
