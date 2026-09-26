import type { Formatter } from "../types.js";
import { defaultClassify, eventLink, eventSource, eventTitle, eventTypeLabel, severityEmoji, truncate } from "./common.js";

/**
 * Slack incoming webhooks: `{text, blocks}`.
 *
 * Slack's mrkdwn treats `<…>` as control sequences — `<!channel>`, `<!here>`,
 * `<@U123>`, `<https://x|label>` — and `&` as the start of an entity. A hostname
 * or summary is operator/host-controlled text, so all three are escaped
 * (Slack's own rule: only `&`, `<`, `>`), and the only mention that can ever
 * appear is the one the channel's own `mention` setting adds.
 */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const slackFormatter: Formatter = {
  format(event, channel, secret, ctx) {
    if (!secret.url) return { kind: "skip", reason: "Channel has no webhook URL" };
    const title = escapeSlack(eventTitle(event));
    const summary = escapeSlack(truncate(event.summary, 2800));
    const emoji = severityEmoji(event);
    const mentionSetting = channel.config.mention;
    const mention =
      event.action !== "resolve" && (event.severity === "critical" || event.severity === "error")
        ? mentionSetting === "here"
          ? "<!here> "
          : mentionSetting === "channel"
            ? "<!channel> "
            : ""
        : "";
    const source = eventSource(event);
    const context = [event.severity, eventTypeLabel(event), source].filter(Boolean).map((s) => escapeSlack(String(s)));
    const link = eventLink(event, ctx.baseUrl);

    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: `${mention}${emoji} *${title}*${summary ? `\n${summary}` : ""}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: context.join(" · ") }] },
    ];
    if (link) {
      blocks.push({
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Open in RackMap" }, url: link }],
      });
    }
    return {
      kind: "http",
      rule: "slack",
      url: secret.url,
      headers: {},
      body: JSON.stringify({ text: `${mention}${emoji} ${title}`, blocks, unfurl_links: false, unfurl_media: false }),
    };
  },
  classify: defaultClassify,
};
