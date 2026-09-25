import type { Formatter } from "../types.js";
import { defaultClassify, eventLink, eventSource, eventTypeLabel, publicPayload, truncate } from "./common.js";

export const PAGERDUTY_URLS = {
  us: "https://events.pagerduty.com/v2/enqueue",
  eu: "https://events.eu.pagerduty.com/v2/enqueue",
} as const;

/**
 * PagerDuty Events API v2.
 *
 * Every trigger carries a stable `dedup_key` (the event's, e.g.
 * `rackmap:server:12`), and the matching resolve sends the same key, so a flap
 * becomes one incident that opens and closes itself instead of a page per
 * probe. Events without a dedup key get a per-event one: they open an incident
 * that a human closes.
 */
export const pagerdutyFormatter: Formatter = {
  format(event, channel, secret, ctx) {
    if (!secret.routingKey) return { kind: "skip", reason: "Channel has no routing key" };
    const url = channel.config.region === "eu" ? PAGERDUTY_URLS.eu : PAGERDUTY_URLS.us;

    if (event.action === "resolve") {
      if (!event.dedupKey) return { kind: "skip", reason: "Resolve event has no dedup key" };
      return {
        kind: "http",
        rule: "pagerduty",
        url,
        headers: {},
        body: JSON.stringify({ routing_key: secret.routingKey, event_action: "resolve", dedup_key: event.dedupKey }),
      };
    }

    const link = eventLink(event, ctx.baseUrl);
    const environment = typeof event.payload.environment === "string" ? event.payload.environment : undefined;
    const component = typeof event.payload.component === "string" ? event.payload.component : undefined;
    const body = {
      routing_key: secret.routingKey,
      event_action: "trigger",
      dedup_key: event.dedupKey ?? `rackmap:event:${event.id}`,
      payload: {
        summary: truncate(event.summary ? `${event.title}: ${event.summary}` : event.title, 1024),
        source: truncate(eventSource(event) ?? "rackmap", 255),
        severity: event.severity,
        timestamp: event.createdAt.toISOString(),
        ...(component ? { component } : {}),
        ...(environment ? { group: environment } : {}),
        class: event.type,
        custom_details: { event: eventTypeLabel(event), ...publicPayload(event) },
      },
      links: link ? [{ href: link, text: "Open in RackMap" }] : [],
      client: "RackMap",
      ...(ctx.baseUrl ? { client_url: ctx.baseUrl } : {}),
    };
    return { kind: "http", rule: "pagerduty", url, headers: {}, body: JSON.stringify(body) };
  },
  classify: defaultClassify,
};
