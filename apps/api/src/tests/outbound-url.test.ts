import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  assertAllowedOutboundUrl,
  checkOutboundUrl,
  classifyAddress,
  OutboundBlockedError,
  postJson,
  type OutboundPolicy,
} from "../lib/outbound-http.js";
import { startReceiver, type Receiver } from "./alert-test-utils.js";

/**
 * SSRF guard for alert channels. Every case here is decided locally: DNS is an
 * injected fake and the only sockets opened go to a loopback receiver.
 */

const STRICT: OutboundPolicy = { allowPrivate: false, allowHttp: false, allowlist: [] };
const fakeDns = (answers: Record<string, string[]>): OutboundPolicy["lookup"] => async (host) => {
  const a = answers[host];
  if (!a) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

function blocked(fn: () => unknown) {
  expect(fn).toThrow(OutboundBlockedError);
}

describe("classifyAddress", () => {
  it.each([
    ["169.254.169.254", "blocked"],
    ["0.0.0.0", "blocked"],
    ["224.0.0.1", "blocked"],
    ["255.255.255.255", "blocked"],
    ["fe80::1", "blocked"],
    ["fd00:ec2::254", "blocked"],
    ["ff02::1", "blocked"],
    ["::", "blocked"],
    ["::ffff:169.254.169.254", "blocked"],
    ["::ffff:a9fe:a9fe", "blocked"],
    ["64:ff9b::a9fe:a9fe", "blocked"],
    ["127.0.0.1", "private"],
    ["::1", "private"],
    ["::ffff:127.0.0.1", "private"],
    ["::ffff:7f00:1", "private"],
    ["10.1.2.3", "private"],
    ["172.16.0.9", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["fd12:3456::1", "private"],
    ["203.0.113.10", "public"],
    ["2001:db8::1", "public"],
    ["not-an-ip", "blocked"],
  ])("%s → %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });
});

describe("checkOutboundUrl — address literals", () => {
  it("blocks loopback in every spelling", () => {
    blocked(() => checkOutboundUrl("https://127.0.0.1/hook", "webhook", STRICT));
    blocked(() => checkOutboundUrl("https://[::1]/hook", "webhook", STRICT));
    blocked(() => checkOutboundUrl("https://[::ffff:127.0.0.1]/hook", "webhook", STRICT));
  });

  it("blocks cloud metadata even with ALLOW_PRIVATE and an allowlist entry", () => {
    const lax: OutboundPolicy = { allowPrivate: true, allowHttp: true, allowlist: ["169.254.0.0/16", "169.254.169.254"] };
    blocked(() => checkOutboundUrl("http://169.254.169.254/latest/meta-data/", "webhook", lax));
    blocked(() => checkOutboundUrl("http://[fd00:ec2::254]/latest/meta-data/", "webhook", lax));
    blocked(() => checkOutboundUrl("http://[::ffff:169.254.169.254]/", "webhook", lax));
  });

  it("blocks 10.x unless allow-private or allowlisted", () => {
    blocked(() => checkOutboundUrl("https://10.0.0.5/hook", "webhook", STRICT));
    expect(() => checkOutboundUrl("https://10.0.0.5/hook", "webhook", { ...STRICT, allowlist: ["10.0.0.0/8"] })).not.toThrow();
    expect(() => checkOutboundUrl("https://10.0.0.5/hook", "webhook", { ...STRICT, allowlist: ["10.0.0.5"] })).not.toThrow();
    expect(() => checkOutboundUrl("https://10.0.0.5/hook", "webhook", { ...STRICT, allowPrivate: true })).not.toThrow();
  });
});

describe("checkOutboundUrl — per-type host policy", () => {
  it("Slack: hooks.slack.com over https only, or an allowlisted host", () => {
    expect(() => checkOutboundUrl("https://hooks.slack.com/services/T0/B0/x", "slack", STRICT)).not.toThrow();
    expect(() => checkOutboundUrl("https://hooks.slack-gov.com/services/T0/B0/x", "slack", STRICT)).not.toThrow();
    blocked(() => checkOutboundUrl("http://hooks.slack.com/services/T0/B0/x", "slack", { ...STRICT, allowHttp: true }));
    blocked(() => checkOutboundUrl("https://hooks.slack.com.example.com/services/x", "slack", STRICT));
    blocked(() => checkOutboundUrl("https://chat.example.com/hooks/x", "slack", STRICT));
    expect(() =>
      checkOutboundUrl("https://chat.example.com/hooks/x", "slack", { ...STRICT, allowlist: ["chat.example.com"] }),
    ).not.toThrow();
  });

  it("Discord: discord.com family and /api/webhooks/ only", () => {
    expect(() => checkOutboundUrl("https://discord.com/api/webhooks/1/abc", "discord", STRICT)).not.toThrow();
    expect(() => checkOutboundUrl("https://canary.discord.com/api/webhooks/1/abc", "discord", STRICT)).not.toThrow();
    expect(() => checkOutboundUrl("https://discordapp.com/api/webhooks/1/abc", "discord", STRICT)).not.toThrow();
    blocked(() => checkOutboundUrl("https://discord.com/api/v10/users/@me", "discord", STRICT));
    blocked(() => checkOutboundUrl("https://evil.example.com/api/webhooks/1/abc", "discord", STRICT));
  });

  it("Teams: Workflows hosts only", () => {
    expect(() =>
      checkOutboundUrl("https://prod-01.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke", "teams", STRICT),
    ).not.toThrow();
    expect(() => checkOutboundUrl("https://tenant.webhook.office.com/webhookb2/x", "teams", STRICT)).not.toThrow();
    blocked(() => checkOutboundUrl("https://logic.azure.com.example.com/workflows/x", "teams", STRICT));
    blocked(() => checkOutboundUrl("https://logic.azure.com/workflows/x", "teams", STRICT));
  });

  it("PagerDuty and Telegram: fixed endpoints", () => {
    expect(() => checkOutboundUrl("https://events.pagerduty.com/v2/enqueue", "pagerduty", STRICT)).not.toThrow();
    expect(() => checkOutboundUrl("https://events.eu.pagerduty.com/v2/enqueue", "pagerduty", STRICT)).not.toThrow();
    blocked(() => checkOutboundUrl("https://events.pagerduty.com/other", "pagerduty", STRICT));
    expect(() => checkOutboundUrl("https://api.telegram.org/bot123:abc/sendMessage", "telegram", STRICT)).not.toThrow();
    blocked(() => checkOutboundUrl("https://api.telegram.org.example.com/bot1/sendMessage", "telegram", STRICT));
  });

  it("generic webhooks need https unless ALLOW_HTTP or allowlisted", () => {
    blocked(() => checkOutboundUrl("http://hooks.example.com/x", "webhook", STRICT));
    expect(() => checkOutboundUrl("http://hooks.example.com/x", "webhook", { ...STRICT, allowHttp: true })).not.toThrow();
    expect(() => checkOutboundUrl("http://hooks.example.com/x", "webhook", { ...STRICT, allowlist: ["*.example.com"] })).not.toThrow();
  });

  it("refuses credentials in the URL and non-http schemes", () => {
    blocked(() => checkOutboundUrl("https://user:pass@hooks.example.com/x", "webhook", STRICT));
    blocked(() => checkOutboundUrl("file:///etc/passwd", "webhook", STRICT));
    blocked(() => checkOutboundUrl("gopher://hooks.example.com/x", "webhook", STRICT));
  });

  it("never echoes the URL in the error", () => {
    try {
      checkOutboundUrl("https://10.0.0.5/secret-token-abc123", "webhook", STRICT);
      throw new Error("expected a block");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-token-abc123");
      expect((err as Error).message).not.toContain("10.0.0.5");
    }
  });
});

describe("assertAllowedOutboundUrl — DNS", () => {
  it("refuses a public-looking name that resolves to a private address", async () => {
    const policy = { ...STRICT, lookup: fakeDns({ "hooks.example.com": ["10.0.0.5"] }) };
    await expect(assertAllowedOutboundUrl("https://hooks.example.com/x", "webhook", policy)).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it("refuses a mixed answer instead of racing it", async () => {
    const policy = { ...STRICT, lookup: fakeDns({ "hooks.example.com": ["203.0.113.7", "169.254.169.254"] }) };
    await expect(assertAllowedOutboundUrl("https://hooks.example.com/x", "webhook", policy)).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it("pins the checked public address", async () => {
    const policy = { ...STRICT, lookup: fakeDns({ "hooks.example.com": ["203.0.113.7"] }) };
    const res = await assertAllowedOutboundUrl("https://hooks.example.com/x", "webhook", policy);
    expect(res.pinned).toEqual({ address: "203.0.113.7", family: 4 });
  });
});

describe("postJson — connect-time behaviour", () => {
  let rx: Receiver;
  beforeAll(async () => {
    rx = await startReceiver((req) =>
      req.path === "/redirect"
        ? { status: 302, headers: { location: "http://169.254.169.254/" } }
        : req.path === "/big"
          ? { status: 200, body: "x".repeat(100_000) }
          : { status: 200, body: "ok" },
    );
  });
  afterAll(async () => {
    await rx.close();
  });

  it("refuses at connect time when DNS answers with a private address, and sends nothing", async () => {
    const before = rx.received.length;
    const policy: OutboundPolicy = { allowPrivate: false, allowHttp: true, allowlist: [], lookup: fakeDns({ "hooks.example.com": ["127.0.0.1"] }) };
    await expect(postJson(`http://hooks.example.com:${rx.port}/x`, "{}", { rule: "webhook", policy })).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
    expect(rx.received.length).toBe(before);
  });

  it("connects to the checked address, not a fresh resolution (pinning)", async () => {
    // hooks.example.com never resolves to loopback in real DNS; the pinned lookup is what connects.
    const policy: OutboundPolicy = { allowPrivate: true, allowHttp: true, allowlist: [], lookup: fakeDns({ "hooks.example.com": ["127.0.0.1"] }) };
    const res = await postJson(`http://hooks.example.com:${rx.port}/pinned`, '{"a":1}', { rule: "webhook", policy });
    expect(res.status).toBe(200);
    const last = rx.received.at(-1)!;
    expect(last.path).toBe("/pinned");
    expect(last.headers.host).toBe(`hooks.example.com:${rx.port}`);
    expect(last.body).toBe('{"a":1}');
  });

  it("does not follow redirects", async () => {
    const policy: OutboundPolicy = { allowPrivate: true, allowHttp: true, allowlist: [] };
    const before = rx.received.length;
    const res = await postJson(`${rx.url}/redirect`, "{}", { rule: "webhook", policy });
    expect(res.status).toBe(302);
    expect(rx.received.length).toBe(before + 1);
  });

  it("caps the response body it keeps", async () => {
    const policy: OutboundPolicy = { allowPrivate: true, allowHttp: true, allowlist: [] };
    const res = await postJson(`${rx.url}/big`, "{}", { rule: "webhook", policy, maxResponseBytes: 4096 });
    expect(res.body.length).toBeLessThanOrEqual(4096);
  });
});
