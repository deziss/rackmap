import type { Formatter } from "../types.js";
import { defaultClassify, eventFacts, eventLink, eventTitle, severityColor, truncate } from "./common.js";

/**
 * Microsoft Teams via a Workflows ("When a Teams webhook request is received")
 * URL, carrying an Adaptive Card 1.4. The old Office 365 connector
 * MessageCard format is retired by Microsoft and deliberately not produced.
 */
export const teamsFormatter: Formatter = {
  format(event, _channel, secret, ctx) {
    if (!secret.url) return { kind: "skip", reason: "Channel has no Workflows URL" };
    const link = eventLink(event, ctx.baseUrl);
    const card = {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        {
          type: "TextBlock",
          text: truncate(eventTitle(event), 300),
          weight: "Bolder",
          size: "Medium",
          wrap: true,
          color: severityColor(event).adaptive,
        },
        ...(event.summary ? [{ type: "TextBlock", text: truncate(event.summary, 4000), wrap: true }] : []),
        { type: "FactSet", facts: eventFacts(event).map((f) => ({ title: f.label, value: f.value })) },
      ],
      actions: link ? [{ type: "Action.OpenUrl", title: "Open in RackMap", url: link }] : [],
    };
    return {
      kind: "http",
      rule: "teams",
      url: secret.url,
      headers: {},
      body: JSON.stringify({
        type: "message",
        attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }],
      }),
    };
  },
  classify: defaultClassify,
};
