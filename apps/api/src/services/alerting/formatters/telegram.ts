import type { Formatter } from "../types.js";
import { defaultClassify, escapeHtml, eventLink, eventTitle, parseRetryAfter, severityEmoji, truncate } from "./common.js";

/**
 * Telegram Bot API sendMessage in `parse_mode: "HTML"`.
 *
 * The legacy "Markdown" mode used before rejected any hostname with an
 * unbalanced `_` ("can't parse entities") and the alert was lost. HTML mode
 * only needs `&`, `<`, `>` (and `"` in attributes) escaped; `_` and `*` are
 * plain text.
 */
export const telegramFormatter: Formatter = {
  format(event, channel, secret, ctx) {
    const chatId = typeof channel.config.chatId === "string" ? channel.config.chatId : "";
    if (!secret.botToken || !chatId) return { kind: "skip", reason: "Channel has no bot token or chat id" };
    const link = eventLink(event, ctx.baseUrl);
    const text =
      `${severityEmoji(event)} <b>${escapeHtml(truncate(eventTitle(event), 300))}</b>` +
      (event.summary ? `\n${escapeHtml(truncate(event.summary, 3200))}` : "") +
      (link ? `\n<a href="${escapeHtml(link)}">Open in RackMap</a>` : "");
    return {
      kind: "http",
      rule: "telegram",
      url: `https://api.telegram.org/bot${secret.botToken}/sendMessage`,
      headers: {},
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    };
  },
  classify(status, headers, body, now) {
    const base = defaultClassify(status, headers, body, now);
    if (status === 429) {
      // {"ok":false,"error_code":429,"parameters":{"retry_after":N}}
      try {
        const parsed = JSON.parse(body) as { parameters?: { retry_after?: unknown } };
        const ra = parsed.parameters?.retry_after;
        if (typeof ra === "number") return { ...base, retryAfterMs: parseRetryAfter(String(ra), now) };
      } catch {
        // keep the header value
      }
    }
    return base;
  },
};
