import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import { prisma } from "../db.js";

/**
 * The Prometheus endpoint replaces storing a time series inside SQLite. If its
 * output stops parsing as the exposition format, scrapes fail silently and the
 * fleet goes dark — so the format itself is asserted here, not just the status.
 */

const app = createApp();
let viewerCookie = "";

beforeAll(async () => {
  viewerCookie = await loginAs(app, "viewer");
});

describe("GET /api/v1/metrics", () => {
  it("requires authentication", async () => {
    const res = await app.request("/api/v1/metrics");
    expect(res.status).toBe(401);
  });

  it("serves the Prometheus text exposition format", async () => {
    const res = await app.request("/api/v1/metrics", { headers: { Cookie: viewerCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
  });

  it("emits HELP and TYPE for every metric it exposes", async () => {
    const body = await (await app.request("/api/v1/metrics", { headers: { Cookie: viewerCookie } })).text();

    const declared = new Set<string>();
    const typed = new Set<string>();
    const sampled = new Set<string>();

    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const help = line.match(/^# HELP (\S+) \S/);
      if (help) {
        declared.add(help[1]!);
        continue;
      }
      const type = line.match(/^# TYPE (\S+) (gauge|counter|histogram|summary)$/);
      if (type) {
        typed.add(type[1]!);
        continue;
      }
      expect(line.startsWith("#")).toBe(false);
      // name{labels} value  |  name value
      const sample = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})? (-?[\d.eE+]+)$/);
      expect(sample, `unparseable exposition line: ${line}`).not.toBeNull();
      sampled.add(sample![1]!);
      expect(Number.isFinite(Number(sample![3]))).toBe(true);
    }

    expect(declared.size).toBeGreaterThan(0);
    expect(typed).toEqual(declared);
    for (const name of sampled) {
      expect(declared.has(name), `${name} has samples but no # HELP`).toBe(true);
    }
  });

  it("exposes the core fleet metrics", async () => {
    const body = await (await app.request("/api/v1/metrics", { headers: { Cookie: viewerCookie } })).text();
    for (const metric of [
      "rackmap_servers_total",
      "rackmap_services_total",
      "rackmap_ssl_certificates_total",
      "rackmap_server_up",
    ]) {
      expect(body).toContain(`# HELP ${metric} `);
    }
  });

  it("escapes label values so a hostname cannot break the format", async () => {
    const body = await (await app.request("/api/v1/metrics", { headers: { Cookie: viewerCookie } })).text();
    for (const line of body.split("\n")) {
      if (line.startsWith("#") || !line.includes("{")) continue;
      const labels = line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
      // Every quote inside the label block must be escaped or a delimiter.
      expect(labels.replace(/\\"/g, "").replace(/"/g, "").includes('"')).toBe(false);
    }
  });
});

describe("GET /api/v1/metrics — heartbeats, runbooks, alerts, patches, drift, access", () => {
  const P = "mx-series";
  // A quote, a backslash and a newline: each must be escaped, not break the line.
  const HOST = `${P}-"quoted"\\host\n.example.com`;
  const HOST_ESCAPED = `${P}-\\"quoted\\"\\\\host\\n.example.com`;
  let serverId = 0;
  let heartbeatId = 0;
  let runbookId = 0;
  let channelId = 0;

  const scrape = async () =>
    (await app.request("/api/v1/metrics", { headers: { Cookie: viewerCookie } })).text();

  /** Value of the single sample line that starts with `prefix` (name plus labels). */
  function sample(body: string, prefix: string): number | undefined {
    const line = body.split("\n").find((l) => l.startsWith(prefix + " "));
    return line === undefined ? undefined : Number(line.slice(prefix.length + 1));
  }

  beforeAll(async () => {
    const server = await prisma.server.create({ data: { hostname: HOST, ip: "192.0.2.50", username: "ops" } });
    serverId = server.id;

    const hb = await prisma.heartbeat.create({
      data: {
        name: `${P}-backup`,
        tokenHash: `${P}-${Date.now()}`,
        tokenEnc: "unused",
        tokenPrefix: "mx",
        serverId,
        status: "up",
        lastPingAt: new Date(Date.now() - 120_000),
      },
    });
    heartbeatId = hb.id;
    await prisma.heartbeat.create({
      data: { name: `${P}-paused`, tokenHash: `${P}-p-${Date.now()}`, tokenEnc: "unused", tokenPrefix: "mx", status: "paused" },
    });

    const rb = await prisma.runbook.create({ data: { name: `${P}-rb`, script: "true" } });
    runbookId = rb.id;
    const run = {
      runbookId,
      runbookVersion: 1,
      scriptSnapshot: "true",
      interpreter: "bash",
      runAs: "sshUser",
      timeoutSec: 60,
      concurrency: 1,
      status: "succeeded",
    };
    await prisma.runbookRun.create({ data: run });
    // Outside the 24h window: must not be counted.
    await prisma.runbookRun.create({ data: { ...run, createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });

    const channel = await prisma.alertChannel.create({ data: { name: `${P}-hook`, type: "webhook", events: [] } });
    channelId = channel.id;
    const event = await prisma.alertEvent.create({
      data: { type: "server_down", severity: "critical", title: `${P}`, summary: `${P}` },
    });
    await prisma.alertDelivery.create({ data: { eventId: event.id, channelId, status: "failed" } });

    await prisma.serverPatchStatus.create({
      data: { serverId, securityCount: 3, upgradableCount: 7, rebootRequired: true },
    });

    const drift = { serverId, category: "users", summary: `${P}`, changes: {} };
    await prisma.driftEvent.create({ data: { ...drift, severity: "critical" } });
    await prisma.driftEvent.create({ data: { ...drift, severity: "critical" } });
    await prisma.driftEvent.create({ data: { ...drift, severity: "warning", acknowledgedAt: new Date() } });

    const expiresAt = new Date(Date.now() + 3600_000);
    await prisma.accessGrant.create({ data: { serverId, kind: "os_user", username: "mxtemp", expiresAt } });
    await prisma.accessGrant.create({
      data: { serverId, kind: "os_user", username: "mxgone", expiresAt, status: "revoked" },
    });
  });

  afterAll(async () => {
    await prisma.heartbeat.deleteMany({ where: { name: { startsWith: `${P}-` } } });
    await prisma.runbookRun.deleteMany({ where: { runbookId } });
    await prisma.runbook.deleteMany({ where: { id: runbookId } });
    await prisma.alertEvent.deleteMany({ where: { title: P } });
    await prisma.alertChannel.deleteMany({ where: { id: channelId } });
    // Cascades patch status, drift events and access grants.
    await prisma.server.deleteMany({ where: { id: serverId } });
  });

  it("declares every new series with HELP and TYPE gauge", async () => {
    const body = await scrape();
    for (const metric of [
      "rackmap_heartbeat_up",
      "rackmap_heartbeat_last_ping_age_seconds",
      "rackmap_heartbeats",
      "rackmap_runbook_runs",
      "rackmap_alert_deliveries",
      "rackmap_patch_security_updates",
      "rackmap_patch_upgradable",
      "rackmap_patch_reboot_required",
      "rackmap_drift_open_events",
      "rackmap_access_grants_active",
    ]) {
      expect(body).toContain(`# HELP ${metric} `);
      expect(body).toContain(`# TYPE ${metric} gauge\n`);
    }
  });

  it("reports heartbeat health and ping age, and leaves paused heartbeats out", async () => {
    const body = await scrape();
    expect(
      sample(body, `rackmap_heartbeat_up{heartbeat="${P}-backup",heartbeat_id="${heartbeatId}",server="${HOST_ESCAPED}"}`),
    ).toBe(1);
    const age = sample(body, `rackmap_heartbeat_last_ping_age_seconds{heartbeat="${P}-backup",heartbeat_id="${heartbeatId}"}`);
    expect(age).toBeGreaterThanOrEqual(120);
    expect(age).toBeLessThan(600);
    expect(body).not.toMatch(new RegExp(`^rackmap_heartbeat_up\\{heartbeat="${P}-paused"`, "m"));
    expect(sample(body, `rackmap_heartbeats{status="paused"}`)).toBeGreaterThanOrEqual(1);
  });

  it("counts runbook runs and alert deliveries over the last 24 hours only", async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [runsInWindow, runsAllTime, failedDeliveries] = await Promise.all([
      prisma.runbookRun.count({ where: { status: "succeeded", createdAt: { gte: since } } }),
      prisma.runbookRun.count({ where: { status: "succeeded" } }),
      prisma.alertDelivery.count({ where: { status: "failed", createdAt: { gte: since } } }),
    ]);
    expect(runsAllTime).toBeGreaterThan(runsInWindow);

    const body = await scrape();
    expect(sample(body, `rackmap_runbook_runs{status="succeeded"}`)).toBe(runsInWindow);
    expect(sample(body, `rackmap_alert_deliveries{status="failed"}`)).toBe(failedDeliveries);
    // Zero-filled so a quiet day reads 0, not "no data".
    expect(body).toMatch(/^rackmap_runbook_runs\{status="rejected"\} \d+$/m);
    expect(body).toMatch(/^rackmap_alert_deliveries\{status="suppressed"\} \d+$/m);
  });

  it("exports the patch scan per server", async () => {
    const body = await scrape();
    const labels = `{server="${HOST_ESCAPED}",server_id="${serverId}"}`;
    expect(sample(body, `rackmap_patch_security_updates${labels}`)).toBe(3);
    expect(sample(body, `rackmap_patch_upgradable${labels}`)).toBe(7);
    expect(sample(body, `rackmap_patch_reboot_required${labels}`)).toBe(1);
  });

  it("counts only unacknowledged drift, by severity", async () => {
    const body = await scrape();
    expect(
      sample(body, `rackmap_drift_open_events{server="${HOST_ESCAPED}",server_id="${serverId}",severity="critical"}`),
    ).toBe(2);
    expect(body).not.toContain(`rackmap_drift_open_events{server="${HOST_ESCAPED}",server_id="${serverId}",severity="warning"}`);
  });

  it("counts active access grants", async () => {
    const active = await prisma.accessGrant.count({ where: { status: "active" } });
    expect(active).toBeGreaterThanOrEqual(1);
    expect(sample(await scrape(), "rackmap_access_grants_active")).toBe(active);
  });

  it("escapes a hostname containing quotes, backslashes and newlines", async () => {
    const body = await scrape();
    expect(body).toContain(`hostname="${HOST_ESCAPED}"`);
    // The raw newline must never reach the output: every line still parses.
    for (const line of body.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      expect(line, `unparseable exposition line: ${line}`).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? -?[\d.eE+]+$/);
    }
  });
});
