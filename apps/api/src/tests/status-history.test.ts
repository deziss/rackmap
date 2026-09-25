import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../db.js";
import { loginAs } from "./helpers.js";
import {
  shouldRecordCheck,
  resetStatusSampling,
  purgeStatusHistory,
  getStatusHistoryStats,
} from "../services/status.service.js";

const app = createApp();
let serverId = 0;
const DAY = 24 * 60 * 60 * 1000;

async function seedChecks(ages: number[]) {
  await prisma.statusCheck.deleteMany({ where: { serverId } });
  // Insert oldest first so ids follow time order, as the scheduler's inserts do.
  for (const ageMs of [...ages].sort((a, b) => b - a)) {
    await prisma.statusCheck.create({
      data: { serverId, status: "up", latencyMs: 5, checkedAt: new Date(Date.now() - ageMs) },
    });
  }
}

beforeAll(async () => {
  const server = await prisma.server.create({
    // A closed loopback port: the probe is refused at once and reports "down".
    data: { hostname: "status-history-test.example.com", ip: "127.0.0.1", sshPort: 1, username: "ops" },
  });
  serverId = server.id;
});

afterAll(async () => {
  await prisma.statusCheck.deleteMany({ where: { serverId } });
  await prisma.server.delete({ where: { id: serverId } });
});

describe("probe history sampling", () => {
  beforeEach(() => resetStatusSampling());

  it("writes on the first probe, on every status change, and once per interval otherwise", () => {
    const interval = 15 * 60_000;
    // No row recorded yet in this process → a steady status is still written.
    expect(shouldRecordCheck(7, "up", "up", 0, interval)).toBe(true);
    // A status change is always written.
    expect(shouldRecordCheck(7, "up", "down", 0, interval)).toBe(true);
    // Interval 0 keeps the old behaviour of one row per probe.
    expect(shouldRecordCheck(7, "up", "up", 0, 0)).toBe(true);
  });

  it("skips steady probes inside the interval once runCheck recorded one", async () => {
    // runCheck() records the row and stamps the sampling state; simulate that
    // by recording through the public path used by the scheduler.
    const { runCheck } = await import("../services/status.service.js");
    await prisma.statusCheck.deleteMany({ where: { serverId } });
    await runCheck(serverId); // refused → "down" (a change from "unknown"), first row written
    await prisma.server.update({ where: { id: serverId }, data: { lastStatus: "down" } });
    const afterFirst = await prisma.statusCheck.count({ where: { serverId } });
    await runCheck(serverId); // same status, inside the 15-minute default interval → skipped
    expect(afterFirst).toBe(1);
    expect(await prisma.statusCheck.count({ where: { serverId } })).toBe(1);
  });
});

describe("purgeStatusHistory", () => {
  it("deletes rows older than the given age", async () => {
    await seedChecks([1 * DAY, 10 * DAY, 40 * DAY, 90 * DAY]);
    const deleted = await purgeStatusHistory({ olderThanDays: 30 });
    expect(deleted).toBe(2);
    expect(await prisma.statusCheck.count({ where: { serverId } })).toBe(2);
  });

  it("keeps only the newest N rows", async () => {
    await prisma.statusCheck.deleteMany({});
    await seedChecks([1_000, 2_000, 3_000, 4_000, 5_000]);
    const deleted = await purgeStatusHistory({ keepNewest: 2 });
    expect(deleted).toBe(3);
    const left = await prisma.statusCheck.findMany({ where: { serverId }, orderBy: { checkedAt: "desc" } });
    expect(left).toHaveLength(2);
    // The two newest (1s and 2s old) survive.
    expect(Date.now() - left[1]!.checkedAt.getTime()).toBeLessThan(2_500);
  });

  it("keepNewest 0 deletes everything and a limit above the row count deletes nothing", async () => {
    await prisma.statusCheck.deleteMany({});
    await seedChecks([1_000, 2_000]);
    expect(await purgeStatusHistory({ keepNewest: 10 })).toBe(0);
    expect(await purgeStatusHistory({ keepNewest: 0 })).toBe(2);
  });

  it("reports stats", async () => {
    await prisma.statusCheck.deleteMany({});
    await seedChecks([1_000, DAY]);
    const stats = await getStatusHistoryStats();
    expect(stats.total).toBe(2);
    expect(stats.servers).toBe(1);
    expect(stats.oldest).not.toBeNull();
  });
});

describe("status history routes", () => {
  let admin = "";
  let editor = "";
  let viewer = "";

  beforeAll(async () => {
    admin = await loginAs(app, "admin");
    editor = await loginAs(app, "editor");
    viewer = await loginAs(app, "viewer");
  });

  const prune = (cookie: string | null, body: unknown) =>
    app.request("/api/v1/status-history/prune", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });

  it("requires a session", async () => {
    expect((await app.request("/api/v1/status-history/stats")).status).toBe(401);
    expect((await prune(null, { olderThanDays: 1 })).status).toBe(401);
  });

  it.each(["viewer", "editor"] as const)("refuses a %s", async (role) => {
    const cookie = role === "viewer" ? viewer : editor;
    expect((await app.request("/api/v1/status-history/stats", { headers: { Cookie: cookie } })).status).toBe(403);
    expect((await prune(cookie, { olderThanDays: 1 })).status).toBe(403);
  });

  it("rejects a prune without a criterion", async () => {
    expect((await prune(admin, {})).status).toBe(400);
  });

  it("lets an admin prune and audits it", async () => {
    await prisma.statusCheck.deleteMany({});
    await seedChecks([1_000, 40 * DAY]);
    const res = await prune(admin, { olderThanDays: 30 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBe(1);
    const audit = await prisma.auditLog.findFirst({ where: { action: "status_history.prune" }, orderBy: { id: "desc" } });
    expect(audit).not.toBeNull();

    const stats = await app.request("/api/v1/status-history/stats", { headers: { Cookie: admin } });
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as { total: number }).total).toBe(1);
  });
});
