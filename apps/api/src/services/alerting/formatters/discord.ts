import type { Formatter } from "../types.js";
import {
  defaultClassify,
  eventFacts,
  eventLink,
  eventTitle,
  eventTypeLabel,
  parseRetryAfter,
  severityColor,
  truncate,
} from "./common.js";

/**
 * Discord webhooks, posted with `?wait=true` so a bad payload comes back as an
 * error instead of a silent 204.
 *
 * `allowed_mentions: {parse: []}` is the important line: without it a
 * hostname or summary containing `@everyone`, `@here` or `<@&role>` pings the
 * whole server. With it, Discord renders the text but notifies nobody.
 */
export const discordFormatter: Formatter = {
  format(event, _channel, secret, ctx) {
    if (!secret.url) return { kind: "skip", reason: "Channel has no webhook URL" };
    const url = new URL(secret.url);
    url.searchParams.set("wait", "true");
    const link = eventLink(event, ctx.baseUrl);
    const embed: Record<string, unknown> = {
      title: truncate(eventTitle(event), 256),
      description: truncate(event.summary, 4000),
      color: severityColor(event).rgb,
      timestamp: event.createdAt.toISOString(),
      fields: eventFacts(event)
        .slice(0, 25)
        .map((f) => ({ name: truncate(f.label, 256), value: truncate(f.value, 1024), inline: true })),
      footer: { text: `RackMap · ${eventTypeLabel(event)}` },
    };
    if (link) embed.url = link;
    return {
      kind: "http",
      rule: "discord",
      url: url.toString(),
      headers: {},
      body: JSON.stringify({ username: "RackMap", embeds: [embed], allowed_mentions: { parse: [] } }),
    };
  },
  classify(status, headers, body, now) {
    const base = defaultClassify(status, headers, body, now);
    if (status === 429) {
      // Discord puts the wait (seconds, fractional) in the JSON body as well as the header.
      try {
        const parsed = JSON.parse(body) as { retry_after?: unknown };
        if (typeof parsed.retry_after === "number") {
          return { ...base, retryAfterMs: parseRetryAfter(String(parsed.retry_after), now) };
        }
      } catch {
        // not JSON — keep the header value
      }
    }
    return base;
  },
};
