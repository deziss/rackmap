import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";

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
