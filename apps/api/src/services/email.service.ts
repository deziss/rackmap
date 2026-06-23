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
});

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  if (!env.SMTP_HOST) {
    console.warn("[email] SMTP_HOST not configured, skipping email dispatch to", options.to);
    return;
  }

  try {
    await transporter.sendMail({
      from: env.SMTP_FROM,
      to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]+>/g, ""), // simple text fallback
    });
    console.log(`[email] Successfully sent to ${options.to}`);
  } catch (error) {
    console.error("[email] Failed to send email:", error);
  }
}
