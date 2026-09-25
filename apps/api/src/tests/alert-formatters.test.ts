import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../db.js";
import { formatters } from "../services/alerting/formatters/index.js";
import { escapeSlack } from "../services/alerting/formatters/slack.js";
import { legacyV1Body, renderTemplate } from "../services/alerting/formatters/webhook.js";
import { PAGERDUTY_URLS } from "../services/alerting/formatters/pagerduty.js";
import { toFormatEvent } from "../services/alerting/send.js";
import { notifyAccessRequest, notifyFlip } from "../services/notify.service.js";
import type { FormatChannel, FormatContext, FormatEvent } from "../services/alerting/types.js";
import { resetAlerts } from "./alert-test-utils.js";

/**
 * Pure formatter output per channel type, plus the legacy_v1 contract: an
 * existing NOTIFY_WEBHOOK_URL receiver must get the same bytes it got before
 * alert channels existed.
 */

const CTX: FormatContext = { deliveryId: "42", now: new Date("2026-01-02T03:04:05.000Z"), baseUrl: "https://rackmap.example.com" };

function ev(over: Partial<FormatEvent> = {}): FormatEvent {
  return {
    id: 7,
    type: "server_down",
    severity: "critical",
    action: "trigger",
    dedupKey: "rackmap:server:12",
    title: "Server web-01 is DOWN",
    summary: "web-01 (192.0.2.10:22) status changed from up to down.",
    payload: { hostname: "web-01", ip: "192.0.2.10", port: 22 },
    serverId: 12,
    serviceId: null,
    heartbeatId: null,
    runbookRunId: null,
    createdAt: new Date("2026-01-02T03:04:00.000Z"),
    ...over,
  };
}

function ch(type: FormatChannel["type"], config: Record<string, unknown> = {}): FormatChannel {
  return { id: 3, name: `${type} channel`, type, config };
}

function httpBody(req: ReturnType<(typeof formatters)["slack"]["format"]>) {
  if (req.kind !== "http") throw new Error(`expected an http request, got ${req.kind}`);
  return { ...req, json: JSON.parse(req.body) as any };
}

describe("slack", () => {
  it("escapes & < > so a hostname cannot inject <!channel> or links", () => {
    const hostile = ev({ title: "Server <!channel> & <https://evil.example.com|click> is DOWN", summary: "<@U123> hi" });
    const { json, url } = httpBody(formatters.slack.format(hostile, ch("slack"), { url: "https://hooks.slack.com/services/T/B/x" }, CTX));
    expect(url).toBe("https://hooks.slack.com/services/T/B/x");
    const all = JSON.stringify(json);
    expect(all).not.toContain("<!channel>");
    expect(all).not.toContain("<@U123>");
    expect(all).not.toContain("<https://evil");
    expect(json.text).toContain("&lt;!channel&gt; &amp; &lt;https://evil.example.com|click&gt;");
    expect(escapeSlack("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("adds only the configured mention, and only for critical/error triggers", () => {
    const withHere = httpBody(formatters.slack.format(ev(), ch("slack", { mention: "here" }), { url: "https://hooks.slack.com/x" }, CTX));
    expect(withHere.json.text.startsWith("<!here> ")).toBe(true);
    const resolved = httpBody(
      formatters.slack.format(ev({ action: "resolve", severity: "info" }), ch("slack", { mention: "here" }), { url: "https://hooks.slack.com/x" }, CTX),
    );
    expect(resolved.json.text).not.toContain("<!here>");
  });

  it("produces the expected body", () => {
    const { json } = httpBody(formatters.slack.format(ev(), ch("slack"), { url: "https://hooks.slack.com/x" }, CTX));
    expect(json).toEqual({
      text: "🔴 Server web-01 is DOWN",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "🔴 *Server web-01 is DOWN*\nweb-01 (192.0.2.10:22) status changed from up to down." } },
        { type: "context", elements: [{ type: "mrkdwn", text: "critical · Server down · web-01" }] },
        {
          type: "actions",
          elements: [{ type: "button", text: { type: "plain_text", text: "Open in RackMap" }, url: "https://rackmap.example.com/servers/12" }],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
  });
});

describe("discord", () => {
  it("disables every mention and waits for the result", () => {
    const hostile = ev({ title: "@everyone web-01 is DOWN", summary: "<@&123> @here" });
    const { json, url } = httpBody(formatters.discord.format(hostile, ch("discord"), { url: "https://discord.com/api/webhooks/1/abc" }, CTX));
    expect(json.allowed_mentions).toEqual({ parse: [] });
    expect(new URL(url).searchParams.get("wait")).toBe("true");
    expect(json.embeds[0].title).toBe("@everyone web-01 is DOWN");
    expect(json.embeds[0].color).toBe(0xef4444);
    expect(json.embeds[0].url).toBe("https://rackmap.example.com/servers/12");
  });

  it("honours retry_after from the JSON body on 429", () => {
    const c = formatters.discord.classify(429, {}, JSON.stringify({ message: "rate limited", retry_after: 1.5 }), CTX.now);
    expect(c).toMatchObject({ ok: false, retryable: true, retryAfterMs: 1500 });
  });
});

describe("teams", () => {
  it("sends a Workflows Adaptive Card 1.4", () => {
    const { json } = httpBody(
      formatters.teams.format(ev(), ch("teams"), { url: "https://prod-01.westus.logic.azure.com/workflows/x" }, CTX),
    );
    expect(json.type).toBe("message");
    expect(json.attachments).toHaveLength(1);
    const a = json.attachments[0];
    expect(a.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(a.content.type).toBe("AdaptiveCard");
    expect(a.content.version).toBe("1.4");
    expect(a.content.body[0]).toMatchObject({ type: "TextBlock", text: "Server web-01 is DOWN", color: "Attention" });
    expect(a.content.body.some((b: any) => b.type === "FactSet")).toBe(true);
    expect(a.content.actions).toEqual([{ type: "Action.OpenUrl", title: "Open in RackMap", url: "https://rackmap.example.com/servers/12" }]);
  });
});

describe("pagerduty", () => {
  const secret = { routingKey: "R0123456789abcdef0123456789abcde" };

  it("trigger and resolve share the dedup_key", () => {
    const trig = httpBody(formatters.pagerduty.format(ev(), ch("pagerduty"), secret, CTX));
    const res = httpBody(formatters.pagerduty.format(ev({ action: "resolve", severity: "info" }), ch("pagerduty"), secret, CTX));
    expect(trig.url).toBe(PAGERDUTY_URLS.us);
    expect(trig.json).toMatchObject({
      routing_key: secret.routingKey,
      event_action: "trigger",
      dedup_key: "rackmap:server:12",
      payload: { source: "web-01", severity: "critical", class: "server_down" },
      client: "RackMap",
    });
    expect(trig.json.links).toEqual([{ href: "https://rackmap.example.com/servers/12", text: "Open in RackMap" }]);
    expect(res.json).toEqual({ routing_key: secret.routingKey, event_action: "resolve", dedup_key: "rackmap:server:12" });
  });

  it("uses the EU endpoint when configured and caps the summary at 1024", () => {
    const long = ev({ summary: "x".repeat(5000) });
    const r = httpBody(formatters.pagerduty.format(long, ch("pagerduty", { region: "eu" }), secret, CTX));
    expect(r.url).toBe(PAGERDUTY_URLS.eu);
    expect(r.json.payload.summary.length).toBeLessThanOrEqual(1024);
  });

  it("skips a resolve that has no dedup key, and keys a one-off trigger per event", () => {
    expect(formatters.pagerduty.format(ev({ action: "resolve", dedupKey: null }), ch("pagerduty"), secret, CTX).kind).toBe("skip");
    const oneOff = httpBody(formatters.pagerduty.format(ev({ dedupKey: null, action: "info" }), ch("pagerduty"), secret, CTX));
    expect(oneOff.json.dedup_key).toBe("rackmap:event:7");
  });

  it("never leaks the legacy stash into custom_details", () => {
    const r = httpBody(formatters.pagerduty.format(ev({ payload: { hostname: "web-01", legacy: { kind: "status_flip" } } }), ch("pagerduty"), secret, CTX));
    expect(r.json.payload.custom_details.legacy).toBeUndefined();
  });
});

describe("telegram", () => {
  it("uses HTML mode and escapes < & but keeps _ literal", () => {
    const e = ev({ title: "db_primary_01 <prod> & friends is DOWN", summary: "a < b && c_d" });
    const r = httpBody(formatters.telegram.format(e, ch("telegram", { chatId: "-1001234567890" }), { botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ" }, CTX));
    expect(r.url).toBe("https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/sendMessage");
    expect(r.json.parse_mode).toBe("HTML");
    expect(r.json.chat_id).toBe("-1001234567890");
    expect(r.json.text).toContain("<b>db_primary_01 &lt;prod&gt; &amp; friends is DOWN</b>");
    expect(r.json.text).toContain("a &lt; b &amp;&amp; c_d");
    expect(r.json.text).toContain('<a href="https://rackmap.example.com/servers/12">Open in RackMap</a>');
  });

  it("honours parameters.retry_after on 429", () => {
    const c = formatters.telegram.classify(429, {}, JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 7 } }), CTX.now);
    expect(c).toMatchObject({ ok: false, retryable: true, retryAfterMs: 7000 });
  });

  it("treats a 400 (bad chat id) as permanent", () => {
    expect(formatters.telegram.classify(400, {}, '{"ok":false,"description":"Bad Request: chat not found"}')).toMatchObject({
      ok: false,
      retryable: false,
    });
  });
});

describe("email", () => {
  it("HTML-escapes interpolated values and strips CR/LF from the subject", () => {
    const e = ev({ title: "Server <script>x</script>\r\nBcc: victim@example.com", summary: "<img src=x onerror=alert(1)>" });
    const r = formatters.email.format(e, ch("email", { emails: ["ops@example.com"] }), {}, CTX);
    if (r.kind !== "email") throw new Error("expected email");
    expect(r.to).toEqual(["ops@example.com"]);
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.subject).not.toMatch(/[\r\n]/);
  });
});

describe("classification", () => {
  it("4xx other than 408/429 is permanent; 5xx, 408 and 429 retry; 3xx fails", () => {
    const c = formatters.slack.classify;
    expect(c(200, {}, "ok")).toEqual({ ok: true, retryable: false });
    expect(c(404, {}, "no_service")).toMatchObject({ ok: false, retryable: false });
    expect(c(410, {}, "channel_is_archived")).toMatchObject({ ok: false, retryable: false });
    expect(c(408, {}, "")).toMatchObject({ ok: false, retryable: true });
    expect(c(429, { "retry-after": "30" }, "")).toMatchObject({ ok: false, retryable: true, retryAfterMs: 30_000 });
    expect(c(503, {}, "")).toMatchObject({ ok: false, retryable: true });
    expect(c(302, {}, "")).toMatchObject({ ok: false, retryable: false });
  });
});

describe("webhook templates", () => {
  const channel = ch("webhook", { format: "template" });

  it("substitutes by walking the tree, so values cannot break out of their string", () => {
    const e = ev({ title: 'x", "admin": true, "y": "' });
    const out = renderTemplate({ text: "Alert: {{event.title}}", sev: "{{event.severity}}" }, e, channel, CTX) as Record<string, unknown>;
    expect(out).toEqual({ text: 'Alert: x", "admin": true, "y": "', sev: "critical" });
    expect(Object.keys(out)).toEqual(["text", "sev"]);
  });

  it("an exact placeholder leaf becomes the raw value; unknown and prototype paths become empty", () => {
    const out = renderTemplate(
      { data: "{{payload}}", port: "{{payload.port}}", missing: "[{{nope.nothing}}]", proto: "{{payload.__proto__}}", n: 3, list: ["{{event.type}}"] },
      ev(),
      channel,
      CTX,
    );
    expect(out).toEqual({ data: { hostname: "web-01", ip: "192.0.2.10", port: 22 }, port: 22, missing: "[]", proto: null, n: 3, list: ["server_down"] });
  });

  it("keys are never substituted", () => {
    const out = renderTemplate({ "{{event.title}}": "v" }, ev(), channel, CTX);
    expect(out).toEqual({ "{{event.title}}": "v" });
  });
});

// ─── legacy_v1: byte-for-byte with the pre-channel notify.service.ts ─────────

/**
 * Copied verbatim from notify.service.ts as it was before alert channels
 * (sendWebhook / sendAccessWebhook), with only `new Date().toISOString()`
 * replaced by the `ts` argument so the comparison is deterministic.
 */
function goldenFlipBody(
  event: { serverId?: number; serviceId?: number; type?: "server" | "service"; hostname: string; ip: string; port: number; from: string; to: string },
  ts: string,
): string {
  return JSON.stringify({
    event: "status_flip",
    type: event.type ?? "server",
    serverId: event.serverId,
    serviceId: event.serviceId,
    hostname: event.hostname,
    ip: event.ip,
    port: event.port,
    from: event.from,
    to: event.to,
    ts,
  });
}

function goldenAccessBody(
  ev: { requestId: number; status: string; type: string; requesterEmail: string; hostname: string; adminNote?: string | null; expiresAt?: Date | null },
  ts: string,
): string {
  return JSON.stringify({
    event: "access_request",
    requestId: ev.requestId,
    status: ev.status,
    type: ev.type,
    requesterEmail: ev.requesterEmail,
    hostname: ev.hostname,
    adminNote: ev.adminNote ?? null,
    expiresAt: ev.expiresAt?.toISOString() ?? null,
    ts,
  });
}

describe("legacy_v1 webhook bodies", () => {
  beforeEach(resetAlerts);

  async function lastEvent() {
    const row = await prisma.alertEvent.findFirst({ orderBy: { id: "desc" } });
    if (!row) throw new Error("no event emitted");
    return toFormatEvent(row);
  }

  it.each([
    { serverId: 12, hostname: "web-01", ip: "192.0.2.10", port: 22, from: "up", to: "down" },
    { serverId: 12, hostname: "web-01", ip: "192.0.2.10", port: 22, from: "down", to: "up" },
    { type: "service" as const, serviceId: 5, hostname: "billing-api", ip: "N/A", port: 0, from: "up", to: "down" },
    { type: "server" as const, serverId: 3, hostname: 'weird "name" \\ ünïcode', ip: "198.51.100.4", port: 2222, from: "up", to: "down" },
  ])("status_flip %# is identical after a jsonb round-trip", async (flip) => {
    await notifyFlip(flip);
    const e = await lastEvent();
    expect(legacyV1Body(e)).toBe(goldenFlipBody(flip, e.createdAt.toISOString()));
  });

  it.each([
    { requestId: 9, status: "approved" as const, type: "ssh" as const, requesterEmail: "viewer@example.com", hostname: "web-01", adminNote: "ok for today", expiresAt: new Date("2026-03-01T10:00:00.000Z") },
    { requestId: 10, status: "rejected" as const, type: "password_reveal" as const, requesterEmail: "viewer@example.com", hostname: "db-01" },
  ])("access_request %# is identical after a jsonb round-trip", async (ar) => {
    await notifyAccessRequest(ar);
    const e = await lastEvent();
    expect(legacyV1Body(e)).toBe(goldenAccessBody(ar, e.createdAt.toISOString()));
  });

  it("the webhook formatter uses it when the channel format is legacy_v1", async () => {
    const flip = { serverId: 12, hostname: "web-01", ip: "192.0.2.10", port: 22, from: "up", to: "down" };
    await notifyFlip(flip);
    const e = await lastEvent();
    const r = httpBody(formatters.webhook.format(e, ch("webhook", { format: "legacy_v1" }), { url: "https://hooks.example.com/x" }, CTX));
    expect(r.body).toBe(goldenFlipBody(flip, e.createdAt.toISOString()));
  });
});
