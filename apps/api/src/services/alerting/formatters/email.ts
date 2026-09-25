import type { Formatter } from "../types.js";
import { escapeHtml, eventFacts, eventLink, eventTitle, severityEmoji } from "./common.js";

/**
 * Email channel: a fixed recipient list (config.emails), sent through SMTP via
 * sendEmailOrThrow so failures reach the delivery log. Every interpolated value
 * is HTML-escaped — hostnames and summaries are not trusted markup.
 */
export const emailFormatter: Formatter = {
  format(event, channel, _secret, ctx) {
    const to = Array.isArray(channel.config.emails)
      ? (channel.config.emails as unknown[]).filter((e): e is string => typeof e === "string")
      : [];
    if (to.length === 0) return { kind: "skip", reason: "Channel has no recipients" };
    const title = eventTitle(event);
    const link = eventLink(event, ctx.baseUrl);
    const facts = eventFacts(event);
    const html =
      `<p>${severityEmoji(event)} <b>${escapeHtml(title)}</b></p>` +
      (event.summary ? `<p>${escapeHtml(event.summary).replace(/\n/g, "<br/>")}</p>` : "") +
      `<table cellpadding="4" style="border-collapse:collapse;font-size:13px">` +
      facts.map((f) => `<tr><td><b>${escapeHtml(f.label)}</b></td><td>${escapeHtml(f.value)}</td></tr>`).join("") +
      `</table>` +
      (link ? `<p><a href="${escapeHtml(link)}">Open in RackMap</a></p>` : "");
    const text = [title, event.summary, ...facts.map((f) => `${f.label}: ${f.value}`), link ?? ""].filter(Boolean).join("\n");
    return {
      kind: "email",
      to,
      // Header injection guard: nodemailer encodes headers, but never let a CR/LF through.
      subject: `[RackMap] ${title}`.replace(/[\r\n]+/g, " ").slice(0, 200),
      html,
      text,
    };
  },
  classify: () => ({ ok: true, retryable: false }),
};
