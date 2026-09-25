import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/**
 * Prometheus http_sd_configs. Prometheus rejects a whole refresh when the body
 * is not the exact shape it expects, and a scrape job quietly keeps its last
 * good target list — so a regression here shows up as "new servers never get
 * scraped", weeks later. The shape is asserted exactly, not just the status.
 */

const app = createApp();
const P = "promsd";

let adminCookie = "";
let viewerCookie = "";
let locationId = 0;
const ids: Record<string, number> = {};
const createdKeyIds: string[] = [];

type Group = { targets: string[]; labels: Record<string, string> };

async function sd(query = "", headers: Record<string, string> = { Cookie: viewerCookie }) {
  const res = await app.request(`/api/v1/prometheus/sd${query}`, { headers });
  return res;
}

async function groups(query = ""): Promise<Group[]> {
  const res = await sd(query);
  expect(res.status).toBe(200);
  return (await res.json()) as Group[];
}

/** Only this suite's servers — other spec files share the database. */
function ours(list: Group[]): Group[] {
  const mine = new Set(Object.values(ids).map(String));
  return list.filter((g) => mine.has(g.labels["rackmap_server_id"]!));
}

function hostnames(list: Group[]): string[] {
  return ours(list)
    .map((g) => g.labels["rackmap_hostname"]!)
    .sort();
}

beforeAll(async () => {
  [adminCookie, viewerCookie] = await Promise.all([loginAs(app, "admin"), loginAs(app, "viewer")]);

  const loc = await prisma.location.create({ data: { name: `${P}-dc1` } });
  locationId = loc.id;
  const type = await prisma.serverType.create({ data: { name: `${P}-baremetal` } });
  const [web, db] = await Promise.all([
    prisma.tag.create({ data: { name: `${P}-web` } }),
    prisma.tag.create({ data: { name: `${P}-db` } }),
  ]);

  const make = async (key: string, data: Omit<Prisma.ServerUncheckedCreateInput, "username">, tagIds: number[] = []) => {
    const s = await prisma.server.create({
      data: { username: "ops", ...data, tags: { create: tagIds.map((tagId) => ({ tagId })) } },
    });
    ids[key] = s.id;
  };

  await make(
    "a",
    {
      hostname: `${P}-a.example.com`,
      ip: "192.0.2.10",
      environment: "cloud",
      locationId: loc.id,
      serverTypeId: type.id,
      lastStatus: "up",
    },
    [web.id, db.id],
  );
  await make("b", { hostname: `${P}-b.example.com`, ip: "192.0.2.11", environment: "on-premise", lastStatus: "down" }, [web.id]);
  await make("c", { hostname: `${P}-c.example.com`, ip: "2001:db8::c", environment: "on-premise", lastStatus: "unknown" });
  await make("evil", { hostname: `${P}-evil\nx="1".example.com`, ip: "192.0.2.13", lastStatus: "up" });
  await make("deleted", { hostname: `${P}-gone.example.com`, ip: "192.0.2.14", deletedAt: new Date() });
});

afterAll(async () => {
  await prisma.server.deleteMany({ where: { hostname: { startsWith: `${P}-` } } });
  await prisma.tag.deleteMany({ where: { name: { startsWith: `${P}-` } } });
  await prisma.location.deleteMany({ where: { name: { startsWith: `${P}-` } } });
  await prisma.serverType.deleteMany({ where: { name: { startsWith: `${P}-` } } });
  if (createdKeyIds.length > 0) await prisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } });
});

describe("GET /api/v1/prometheus/sd — auth", () => {
  it("requires authentication", async () => {
    const res = await sd("", {});
    expect(res.status).toBe(401);
  });

  it("rejects an unknown API key", async () => {
    const res = await sd("", { Authorization: `Bearer sk_${"0".repeat(64)}` });
    expect(res.status).toBe(401);
  });

  it("accepts a viewer-scoped API key, the way Prometheus authenticates", async () => {
    const mint = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: `${P}-scraper`, scopeRole: "viewer" }),
    });
    const key = (await mint.json()) as { id: string; key: string };
    createdKeyIds.push(key.id);
    expect(key.key).toMatch(/^sk_/);

    const res = await sd("", { Authorization: `Bearer ${key.key}` });
    expect(res.status).toBe(200);
    expect(ours((await res.json()) as Group[]).length).toBeGreaterThan(0);
  });
});

describe("GET /api/v1/prometheus/sd — shape", () => {
  it("serves JSON target groups, one per non-deleted server", async () => {
    const res = await sd();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const list = (await res.json()) as Group[];
    expect(Array.isArray(list)).toBe(true);
    expect(hostnames(list)).toEqual([`${P}-a.example.com`, `${P}-b.example.com`, `${P}-c.example.com`, `${P}-evil x="1".example.com`]);
  });

  it("emits exactly the documented labels, all strings", async () => {
    const a = ours(await groups()).find((g) => g.labels["rackmap_server_id"] === String(ids["a"]))!;
    expect(a).toEqual({
      targets: ["192.0.2.10:9100"],
      labels: {
        rackmap_server_id: String(ids["a"]),
        rackmap_hostname: `${P}-a.example.com`,
        rackmap_environment: "cloud",
        rackmap_location: `${P}-dc1`,
        rackmap_server_type: `${P}-baremetal`,
        rackmap_status: "up",
        rackmap_tags: `,${P}-db,${P}-web,`,
      },
    });
    for (const g of await groups()) {
      expect(g.targets).toHaveLength(1);
      for (const v of Object.values(g.labels)) expect(typeof v).toBe("string");
    }
  });

  it("wraps tags in commas and leaves an untagged server empty", async () => {
    const list = ours(await groups());
    const byId = (k: string) => list.find((g) => g.labels["rackmap_server_id"] === String(ids[k]))!;
    expect(byId("b").labels["rackmap_tags"]).toBe(`,${P}-web,`);
    expect(byId("c").labels["rackmap_tags"]).toBe("");
    expect(byId("c").labels["rackmap_location"]).toBe("");
  });

  it("strips control characters from label values", async () => {
    const evil = ours(await groups()).find((g) => g.labels["rackmap_server_id"] === String(ids["evil"]))!;
    for (const v of Object.values(evil.labels)) expect(v).not.toMatch(/[\u0000-\u001f]/);
  });

  it("brackets IPv6 literals", async () => {
    const c = ours(await groups()).find((g) => g.labels["rackmap_server_id"] === String(ids["c"]))!;
    expect(c.targets).toEqual(["[2001:db8::c]:9100"]);
  });

  it("honours port and address=hostname", async () => {
    const a = ours(await groups("?port=9256&address=hostname")).find(
      (g) => g.labels["rackmap_server_id"] === String(ids["a"]),
    )!;
    expect(a.targets).toEqual([`${P}-a.example.com:9256`]);
  });

  it("returns 200 with [] when nothing matches", async () => {
    const res = await sd(`?tag=${P}-no-such-tag`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("GET /api/v1/prometheus/sd — filters", () => {
  it("filters by environment, case-insensitively", async () => {
    expect(hostnames(await groups("?environment=CLOUD"))).toEqual([`${P}-a.example.com`]);
  });

  it("filters by location id or name", async () => {
    expect(hostnames(await groups(`?location=${locationId}`))).toEqual([`${P}-a.example.com`]);
    expect(hostnames(await groups(`?location=${P}-dc1`))).toEqual([`${P}-a.example.com`]);
  });

  it("requires every repeated tag", async () => {
    expect(hostnames(await groups(`?tag=${P}-web`))).toEqual([`${P}-a.example.com`, `${P}-b.example.com`]);
    expect(hostnames(await groups(`?tag=${P}-web&tag=${P}-db`))).toEqual([`${P}-a.example.com`]);
  });

  it("filters by last probe status", async () => {
    expect(hostnames(await groups("?status=down"))).toEqual([`${P}-b.example.com`]);
    expect(hostnames(await groups("?status=unknown"))).toEqual([`${P}-c.example.com`]);
  });

  it("excludeDown drops servers probed as down", async () => {
    const names = hostnames(await groups("?excludeDown=true"));
    expect(names).not.toContain(`${P}-b.example.com`);
    expect(names).toContain(`${P}-a.example.com`);
    expect(names).toContain(`${P}-c.example.com`);
    expect(hostnames(await groups("?excludeDown=false"))).toContain(`${P}-b.example.com`);
  });

  it.each(["?port=0", "?port=65536", "?port=abc", "?address=fqdn", "?status=sideways", "?excludeDown=maybe"])(
    "rejects invalid query %s with 400",
    async (q) => {
      const res = await sd(q);
      expect(res.status).toBe(400);
    },
  );
});
