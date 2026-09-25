import nodemailer from "nodemailer";
import { env } from "../env.js";

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST || "",
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465, // true for 465, false for other ports
  auth:
    env.SMTP_USER && env.SMTP_PASS
      ? {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        }
      : undefined,
  // nodemailer's defaults (2 min connect, 10 min socket) outlast the alert
  // dispatcher's claim lease, so a hung SMTP server could let a second replica
  // re-send the same alert. Keep a whole send well inside the lease.
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
});

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

/** SMTP is not configured at all: retrying will not help. */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super("SMTP_HOST is not configured");
    this.name = "EmailNotConfiguredError";
  }
}

export function isEmailConfigured(): boolean {
  return !!env.SMTP_HOST;
}

/** Escape text for interpolation into an HTML email body. */
export function escapeEmailHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toMail(options: SendEmailOptions) {
  return {
    from: env.SMTP_FROM,
    to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
    subject: options.subject,
    html: options.html,
    text: options.text || options.html.replace(/<[^>]+>/g, ""), // simple text fallback
  };
}

/**
 * Send or throw. The alert dispatcher uses this so an SMTP failure becomes a
 * retry and a delivery-log entry instead of a line in the console.
 */
export async function sendEmailOrThrow(options: SendEmailOptions): Promise<void> {
  if (!env.SMTP_HOST) throw new EmailNotConfiguredError();
  await transporter.sendMail(toMail(options));
}

/** Best-effort send: logs and swallows failures (preference emails, welcome mail). */
export async function sendEmail(options: SendEmailOptions): Promise<void> {
  if (!env.SMTP_HOST) {
    console.warn("[email] SMTP_HOST not configured, skipping email dispatch");
    return;
  }

  try {
    await transporter.sendMail(toMail(options));
    console.log(`[email] Successfully sent to ${Array.isArray(options.to) ? options.to.length : 1} recipient(s)`);
  } catch (error) {
    console.error("[email] Failed to send email:", (error as Error).message);
  }
}
