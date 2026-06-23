import { env } from "../env.js";
import { prisma } from "../db.js";
import { sendEmail } from "./email.service.js";
import { NotificationPreference } from "@prisma/client";

interface FlipEvent {
  serverId: number;
  hostname: string;
  ip: string;
  port: number;
  from: string;
  to: string;
}

export interface AccessRequestEvent {
  requestId: number;
  status: "approved" | "rejected";
  type: "ssh" | "password_reveal";
  requesterEmail: string;
  hostname: string;
  adminNote?: string | null;
  expiresAt?: Date | null;
}

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

async function sendWebhook(event: FlipEvent): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "status_flip",
      serverId: event.serverId,
      hostname: event.hostname,
      ip: event.ip,
      port: event.port,
      from: event.from,
      to: event.to,
      ts: new Date().toISOString(),
    }),
  }).catch((e) => console.error("[notify] webhook failed:", (e as Error).message));
}

async function sendTelegram(event: FlipEvent): Promise<void> {
  if (!env.NOTIFY_TELEGRAM_BOT_TOKEN || !env.NOTIFY_TELEGRAM_CHAT_ID) return;
  const emoji = event.to === "up" ? "✅" : "🔴";
  const text = `${emoji} *${event.hostname}* (${event.ip}:${event.port})\nStatus: ${event.from} → ${event.to}`;
  const url = `https://api.telegram.org/bot${env.NOTIFY_TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.NOTIFY_TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
  }).catch((e) => console.error("[notify] telegram failed:", (e as Error).message));
}

async function sendAccessWebhook(ev: AccessRequestEvent): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "access_request",
      requestId: ev.requestId,
      status: ev.status,
      type: ev.type,
      requesterEmail: ev.requesterEmail,
      hostname: ev.hostname,
      adminNote: ev.adminNote ?? null,
      expiresAt: ev.expiresAt?.toISOString() ?? null,
      ts: new Date().toISOString(),
    }),
  }).catch((e) => console.error("[notify] webhook access_request failed:", (e as Error).message));
}

async function sendAccessTelegram(ev: AccessRequestEvent): Promise<void> {
  if (!env.NOTIFY_TELEGRAM_BOT_TOKEN || !env.NOTIFY_TELEGRAM_CHAT_ID) return;
  const emoji = ev.status === "approved" ? "✅" : "❌";
  const typeLabel = ev.type === "ssh" ? "SSH Terminal" : "Password Reveal";
  const expiry = ev.expiresAt ? `\nExpires: ${ev.expiresAt.toUTCString()}` : "";
  const note = ev.adminNote ? `\nNote: ${ev.adminNote}` : "";
  const text =
    `${emoji} Access request *${ev.status}*\n` +
    `User: ${ev.requesterEmail}\n` +
    `Server: *${ev.hostname}*\n` +
    `Type: ${typeLabel}${note}${expiry}`;
  const url = `https://api.telegram.org/bot${env.NOTIFY_TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.NOTIFY_TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
  }).catch((e) => console.error("[notify] telegram access_request failed:", (e as Error).message));
}

export async function notifyFlip(event: FlipEvent): Promise<void> {
  await Promise.allSettled([sendWebhook(event), sendTelegram(event)]);
  
  const emails = await getOptedInEmails("serverUpDown");
  if (emails.length > 0) {
    const emoji = event.to === "up" ? "✅" : "🔴";
    await sendEmail({
      to: emails,
      subject: `[CloudScope] Server ${event.hostname} is ${event.to.toUpperCase()}`,
      html: `<p>${emoji} The server <b>${event.hostname}</b> (${event.ip}:${event.port}) status changed from <b>${event.from}</b> to <b>${event.to}</b>.</p>`,
    });
    await logAuditNotification("email_sent", "Server", String(event.serverId), { type: "serverUpDown", count: emails.length });
  }
}

export async function notifyAccessRequest(ev: AccessRequestEvent): Promise<void> {
  await Promise.allSettled([sendAccessWebhook(ev), sendAccessTelegram(ev)]);
}

export async function notifyNewServer(server: { id: number; hostname: string; ip: string }): Promise<void> {
  const emails = await getOptedInEmails("newServerAdded");
  if (emails.length > 0) {
    await sendEmail({
      to: emails,
      subject: `[CloudScope] New Server Added: ${server.hostname}`,
      html: `<p>A new server has been added to CloudScope.</p><p><b>Hostname:</b> ${server.hostname}<br/><b>IP:</b> ${server.ip}</p>`,
    });
    await logAuditNotification("email_sent", "Server", String(server.id), { type: "newServerAdded", count: emails.length });
  }
}

export async function notifyMetricAlert(
  type: "highCpu" | "ramFull" | "diskFull" | "diskUnmounted" | "gpuCountChanged",
  server: { id: number; hostname: string },
  details: string
): Promise<void> {
  const emails = await getOptedInEmails(type);
  if (emails.length > 0) {
    await sendEmail({
      to: emails,
      subject: `[CloudScope] Alert for ${server.hostname}: ${type}`,
      html: `<p><b>Alert on server ${server.hostname}</b></p><p>${details}</p>`,
    });
    await logAuditNotification("email_sent", "Server", String(server.id), { type, details, count: emails.length });
  }
}

export async function notifyUserRegistered(user: { id: string; email: string; name: string }): Promise<void> {
  // 1. Notify admins who opted in
  const adminEmails = await getOptedInEmails("userRegistered", true);
  if (adminEmails.length > 0) {
    await sendEmail({
      to: adminEmails,
      subject: `[CloudScope] New User Registered: ${user.name}`,
      html: `<p>A new user just registered.</p><p><b>Name:</b> ${user.name}<br/><b>Email:</b> ${user.email}</p>`,
    });
    await logAuditNotification("email_sent", "User", user.id, { type: "userRegisteredAdminAlert", count: adminEmails.length });
  }

  // 2. Send welcome email to the user
  if (env.SMTP_HOST) {
    await sendEmail({
      to: user.email,
      subject: `Welcome to CloudScope`,
      html: `<p>Hi ${user.name},</p><p>Welcome to CloudScope! Your account has been successfully created.</p>`,
    });
    await logAuditNotification("email_sent", "User", user.id, { type: "userWelcome" });
  }
}
