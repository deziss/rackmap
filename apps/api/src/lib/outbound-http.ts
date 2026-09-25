import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { env } from "../env.js";

/**
 * Outbound HTTP for alert channels, with an SSRF guard.
 *
 * An alert channel is an admin-supplied URL that the API POSTs to from inside
 * the network perimeter, on a timer, with no human watching. Without a guard it
 * is a request-forgery primitive: point a "webhook" at 169.254.169.254 and the
 * delivery log hands back cloud metadata; point it at an internal admin panel
 * and the dispatcher pokes it every few seconds. (http-check.ts has no such
 * guard — the health probe is its own, separate problem.)
 *
 * What this module guarantees:
 *   - Per-type host policy: a "Slack" channel can only talk to Slack, and so on.
 *   - The hostname is resolved HERE, every resolved address is checked, and the
 *     socket is pinned to the checked address through a custom `lookup`. The
 *     connect-time resolution can therefore not differ from the checked one
 *     (DNS rebinding), and TLS still verifies the certificate for the hostname.
 *   - Every step is bounded: DNS by OUTBOUND_DNS_TIMEOUT_MS, then the request
 *     and response by the caller's timeout. Both are retryable failures.
 *   - Redirects are never followed; a 3xx is reported as a failure.
 *   - Responses are read up to `maxResponseBytes` (4 KB) and then dropped.
 *   - URLs are never logged or put into errors: Telegram bot tokens and webhook
 *     secrets live in them.
 *
 * The policy is injectable so tests can allow 127.0.0.1 and fake DNS answers
 * without any real network access.
 */

export type OutboundRule = "slack" | "teams" | "discord" | "pagerduty" | "telegram" | "webhook";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface OutboundPolicy {
  /** Allow RFC1918 / loopback / CGNAT / ULA destinations. */
  allowPrivate: boolean;
  /** Allow plain http:// for generic webhooks. */
  allowHttp: boolean;
  /** Hostnames (exact or `*.suffix`), IPs and CIDRs exempt from the https + private-range rules. */
  allowlist: string[];
  /** Resolver; defaults to dns.lookup({all:true}). Tests inject a fake. */
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Cap on the DNS step; defaults to OUTBOUND_DNS_TIMEOUT_MS. Tests shorten it. */
  lookupTimeoutMs?: number;
}

/**
 * Upper bound on name resolution. getaddrinfo has no timeout of its own (a dead
 * resolver can stall it for a minute or more), and postJson's request timer
 * only starts once an address is pinned. The alert dispatcher sizes its claim
 * lease from this plus ALERT_OUTBOUND_TIMEOUT_MS.
 */
export const OUTBOUND_DNS_TIMEOUT_MS = 5_000;

/** The destination is refused by policy. Never retryable; the message is safe to store and show. */
export class OutboundBlockedError extends Error {
  readonly code = "OUTBOUND_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "OutboundBlockedError";
  }
}

/** The request failed on the wire (DNS, connect, TLS, timeout). Retryable; message is sanitized. */
export class OutboundNetworkError extends Error {
  readonly code = "OUTBOUND_NETWORK";
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "OutboundNetworkError";
  }
}

// ─── Address classification ──────────────────────────────────────────────────

/**
 * Never reachable, whatever the env or allowlist says: link-local (cloud
 * metadata lives at 169.254.169.254 and fd00:ec2::254), "this network",
 * multicast and reserved space.
 */
const ALWAYS_BLOCKED = new net.BlockList();
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4");
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, includes 255.255.255.255
ALWAYS_BLOCKED.addAddress("::", "ipv6");
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6");
ALWAYS_BLOCKED.addSubnet("ff00::", 8, "ipv6");
ALWAYS_BLOCKED.addAddress("fd00:ec2::254", "ipv6");

/** Internal ranges: refused unless ALERT_OUTBOUND_ALLOW_PRIVATE or allowlisted. */
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
PRIVATE.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6"); // ULA
PRIVATE.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local

/** Expand any valid IPv6 literal into 16 bytes. Assumes net.isIPv6(input). */
function ipv6Bytes(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const p = tail.split(".").map(Number) as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/**
 * The IPv4 address hidden inside an IPv6 one, if any: mapped (::ffff:a.b.c.d),
 * SIIT (::ffff:0:a.b.c.d), deprecated compatible (::a.b.c.d) and NAT64
 * (64:ff9b::a.b.c.d). Without this, `[::ffff:127.0.0.1]` walks straight past a
 * v4-only blocklist to loopback.
 */
function embeddedIPv4(b: number[]): string | null {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4;
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return v4;
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4;
  if (zero(0, 12) && !(zero(12, 15) && (b[15] === 0 || b[15] === 1))) return v4;
  return null;
}

export type AddressClass = "blocked" | "private" | "public";

/** Classify an IP literal. Anything unparseable is "blocked". */
export function classifyAddress(address: string): AddressClass {
  let ip = address.replace(/^\[|\]$/g, "");
  if (net.isIPv6(ip)) {
    const bytes = ipv6Bytes(ip);
    if (!bytes) return "blocked";
    const v4 = embeddedIPv4(bytes);
    if (v4) ip = v4;
  }
  const family = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
  if (!family) return "blocked";
  if (ALWAYS_BLOCKED.check(ip, family)) return "blocked";
  if (PRIVATE.check(ip, family)) return "private";
  return "public";
}

// ─── Policy ──────────────────────────────────────────────────────────────────

let policyOverride: OutboundPolicy | null = null;
let envPolicy: OutboundPolicy | null = null;

/** The env-derived policy (ALERT_OUTBOUND_*), or the test override. */
export function getOutboundPolicy(): OutboundPolicy {
  if (policyOverride) return policyOverride;
  envPolicy ??= {
    allowPrivate: env.ALERT_OUTBOUND_ALLOW_PRIVATE,
    allowHttp: env.ALERT_OUTBOUND_ALLOW_HTTP,
    allowlist: env.ALERT_OUTBOUND_ALLOWLIST.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
  return envPolicy;
}

/** Test-only: replace the process-wide policy (null restores the env policy). */
export function setOutboundPolicyForTests(policy: OutboundPolicy | null): void {
  policyOverride = policy;
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function hostAllowlisted(host: string, policy: OutboundPolicy): boolean {
  return policy.allowlist.some((entry) => {
    if (entry.includes("/") || net.isIP(entry)) return false;
    if (entry.startsWith("*.")) return host.endsWith(entry.slice(1)) && host.length > entry.length - 1;
    return host === entry;
  });
}

function addressAllowlisted(address: string, policy: OutboundPolicy): boolean {
  const family = net.isIPv4(address) ? "ipv4" : "ipv6";
  for (const entry of policy.allowlist) {
    try {
      if (entry.includes("/")) {
        const [base, bits] = entry.split("/");
        if (!base || !bits || !net.isIP(base)) continue;
        const list = new net.BlockList();
        list.addSubnet(base, Number(bits), net.isIPv4(base) ? "ipv4" : "ipv6");
        if (list.check(address, family)) return true;
      } else if (net.isIP(entry) && entry === address.toLowerCase()) {
        return true;
      }
    } catch {
      // A malformed allowlist entry allows nothing.
    }
  }
  return false;
}

function assertAddressAllowed(address: string, policy: OutboundPolicy, hostIsAllowlisted: boolean): void {
  const cls = classifyAddress(address);
  if (cls === "blocked") {
    throw new OutboundBlockedError("Destination address is link-local, metadata, multicast or reserved and is always refused");
  }
  if (cls === "private" && !policy.allowPrivate && !hostIsAllowlisted && !addressAllowlisted(address, policy)) {
    throw new OutboundBlockedError(
      "Destination resolves to a private or loopback address (set ALERT_OUTBOUND_ALLOW_PRIVATE or allowlist it)",
    );
  }
}

const SLACK_HOSTS = ["hooks.slack.com", "hooks.slack-gov.com"];
const DISCORD_HOSTS = [
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
  "ptb.discordapp.com",
  "canary.discordapp.com",
];
const TEAMS_SUFFIXES = [".logic.azure.com", ".powerplatform.com", ".webhook.office.com"];
const PAGERDUTY_HOSTS = ["events.pagerduty.com", "events.eu.pagerduty.com"];
const TELEGRAM_HOSTS = ["api.telegram.org"];

export interface CheckedUrl {
  url: URL;
  host: string;
  /** The host (not an IP) is on the allowlist, which exempts it from https/private rules. */
  allowlisted: boolean;
}

/**
 * Synchronous checks: scheme, credentials, per-type host policy and — for IP
 * literals — the address itself. Throws OutboundBlockedError with a message
 * that never echoes the URL.
 */
export function checkOutboundUrl(rawUrl: string, rule: OutboundRule, policy: OutboundPolicy = getOutboundPolicy()): CheckedUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundBlockedError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OutboundBlockedError("Only http(s) URLs are supported");
  }
  if (url.username || url.password) {
    throw new OutboundBlockedError("Credentials in the URL are not supported; use a custom header instead");
  }
  const host = normalizeHost(url.hostname);
  const allowlisted = hostAllowlisted(host, policy);
  const https = url.protocol === "https:";

  const fixed = (hosts: string[], label: string, pathOk = true) => {
    if (!hosts.includes(host) || !https || !pathOk) {
      throw new OutboundBlockedError(`${label} URLs must be https://${hosts[0]}/…`);
    }
  };

  switch (rule) {
    case "slack":
      // Slack proper, or an allowlisted Slack-compatible receiver (Mattermost, Rocket.Chat…).
      if (SLACK_HOSTS.includes(host)) {
        if (!https) throw new OutboundBlockedError("Slack webhook URLs must use https");
      } else if (!allowlisted) {
        throw new OutboundBlockedError("Slack webhooks must be on hooks.slack.com (or an allowlisted host)");
      }
      break;
    case "discord":
      if (!DISCORD_HOSTS.includes(host) || !https || !url.pathname.startsWith("/api/webhooks/")) {
        throw new OutboundBlockedError("Discord webhook URLs must be https://discord.com/api/webhooks/…");
      }
      break;
    case "teams":
      if (!https || !TEAMS_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)) {
        throw new OutboundBlockedError(
          "Teams Workflows URLs must be https on *.logic.azure.com, *.powerplatform.com or *.webhook.office.com",
        );
      }
      break;
    case "pagerduty":
      fixed(PAGERDUTY_HOSTS, "PagerDuty", url.pathname === "/v2/enqueue");
      break;
    case "telegram":
      fixed(TELEGRAM_HOSTS, "Telegram", url.pathname.startsWith("/bot"));
      break;
    case "webhook":
      break;
  }

  if (!https && !policy.allowHttp && !allowlisted && !(net.isIP(host) && addressAllowlisted(host, policy))) {
    throw new OutboundBlockedError("Webhook URLs must use https (set ALERT_OUTBOUND_ALLOW_HTTP or allowlist the host)");
  }
  if (net.isIP(host)) assertAddressAllowed(host, policy, allowlisted);
  return { url, host, allowlisted };
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const res = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
}

/**
 * Full check including DNS: every address the name resolves to must pass (a
 * mixed answer is refused rather than raced). Returns the address to pin to.
 */
export async function assertAllowedOutboundUrl(
  rawUrl: string,
  rule: OutboundRule,
  policy: OutboundPolicy = getOutboundPolicy(),
): Promise<CheckedUrl & { pinned: ResolvedAddress }> {
  const checked = checkOutboundUrl(rawUrl, rule, policy);
  if (net.isIP(checked.host)) {
    return { ...checked, pinned: { address: checked.host, family: net.isIPv6(checked.host) ? 6 : 4 } };
  }
  const lookupTimeoutMs = policy.lookupTimeoutMs ?? OUTBOUND_DNS_TIMEOUT_MS;
  let addresses: ResolvedAddress[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A lookup that loses the race keeps running in the libuv pool; its answer is dropped.
    addresses = await Promise.race([
      (policy.lookup ?? defaultLookup)(checked.host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OutboundNetworkError(`DNS lookup timed out after ${lookupTimeoutMs}ms`, true)),
          lookupTimeoutMs,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof OutboundNetworkError) throw err;
    const code = (err as { code?: string }).code ?? "ENOTFOUND";
    throw new OutboundNetworkError(`DNS lookup failed (${code})`);
  } finally {
    clearTimeout(timer);
  }
  if (addresses.length === 0) throw new OutboundNetworkError("DNS lookup returned no addresses");
  for (const a of addresses) assertAddressAllowed(a.address, policy, checked.allowlisted);
  return { ...checked, pinned: addresses[0]! };
}

export interface PostJsonOptions {
  rule: OutboundRule;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  policy?: OutboundPolicy;
}

export interface OutboundResponse {
  status: number;
  headers: Record<string, string>;
  /** At most maxResponseBytes of the body, decoded as UTF-8. */
  body: string;
}

/**
 * POST a JSON body to a policy-checked URL, pinned to the checked address.
 * Resolves with any HTTP status (the caller classifies it); rejects with
 * OutboundBlockedError (policy) or OutboundNetworkError (wire).
 */
export async function postJson(rawUrl: string, body: string, opts: PostJsonOptions): Promise<OutboundResponse> {
  const policy = opts.policy ?? getOutboundPolicy();
  const { url, host, pinned } = await assertAllowedOutboundUrl(rawUrl, opts.rule, policy);
  const timeoutMs = opts.timeoutMs ?? env.ALERT_OUTBOUND_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? 4096;
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  // Pinned resolver: whatever net.connect asks for, it gets the address we checked.
  // Handles both callback shapes (autoSelectFamily asks with {all:true}).
  const lookup = ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
    if (options?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  }) as unknown as net.LookupFunction;

  return new Promise<OutboundResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "user-agent": "RackMap-Alerts/1.0",
          ...opts.headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        lookup,
        agent: false,
        ...(isHttps && !net.isIP(host) ? { servername: host } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () =>
          finish(() => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
          });
        res.on("data", (chunk: Buffer) => {
          if (size >= maxBytes) return;
          const room = maxBytes - size;
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
          chunks.push(slice);
          size += slice.length;
          if (size >= maxBytes) {
            // Enough to classify the response; do not buffer an attacker-sized body.
            done();
            res.destroy();
          }
        });
        res.on("end", done);
        res.on("error", done);
        res.on("close", done);
      },
    );

    const timer = setTimeout(() => {
      finish(() => reject(new OutboundNetworkError(`Timed out after ${timeoutMs}ms`, true)));
      req.destroy();
    }, timeoutMs);

    req.on("error", (err: NodeJS.ErrnoException) => {
      // Never the message: it can carry the host, and for some errors the path.
      finish(() => reject(new OutboundNetworkError(`Request failed (${err.code ?? "network error"})`)));
    });
    req.end(body);
  });
}
