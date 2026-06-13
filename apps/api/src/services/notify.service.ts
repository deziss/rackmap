import { env } from "../env.js";

interface FlipEvent {
  serverId: number;
  hostname: string;
  ip: string;
  port: number;
  from: string;
  to: string;
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

export async function notifyFlip(event: FlipEvent): Promise<void> {
  await Promise.allSettled([sendWebhook(event), sendTelegram(event)]);
}
