import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// Approval notifications are not what these tests are about; keep them off the
// alert fan-out.
vi.mock("../services/alerting/emit.js", () => ({
  emitAlert: vi.fn(async () => ({ eventId: 0, queued: 0 })),
}));

const { createApp } = await import("../app.js");
const { loginAs } = await import("./helpers.js");
const { prisma } = await import("../db.js");
const { resetRateLimits } = await import("../middleware/rate-limit.js");

/**
 * The runbook API's authorization and approval rules. The important invariants:
 * nobody approves their own run (admins included), an editor cannot run root
 * code without a second person, authoring is admin-only, and an empty target
 * selector never means "the whole fleet".
 */

const app = createApp();
type Role = "admin" | "admin2" | "editor" | "viewer";
const cookies = {} as Record<Role, string>;
const serverIds: number[] = [];
let prodServerId = 0;

async function call(role: Role | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(role ? { Cookie: cookies[role] } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json };
}

async function setLicense(tier: "pro" | "free") {
  await prisma.systemLicense.upsert({
    where: { id: 1 },
    create: { id: 1, key: tier === "pro" ? "TEST-PRO-LICENSE-KEY" : null, tier, maxServers: tier === "pro" ? -1 : 10 },
    update: { key: tier === "pro" ? "TEST-PRO-LICENSE-KEY" : null, tier, maxServers: tier === "pro" ? -1 : 10, expiresAt: null },
  });
}

let seq = 0;
async function createRunbook(over: Record<string, unknown> = {}) {
  const res = await call("admin", "POST", "/runbooks", {
    name: `rbr-${++seq}`,
    script: "echo hello\n",
    targetSelector: { serverIds },
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; version: number; name: string };
}

beforeAll(async () => {
  for (const role of ["admin", "admin2", "editor", "viewer"] as const) cookies[role] = await loginAs(app, role);
  for (let i = 0; i < 3; i++) {
    const s = await prisma.server.create({
      data: { hostname: `rbr-${i}.example.com`, ip: `203.0.113.${i + 1}`, username: "ops", environment: "cloud" },
    });
    serverIds.push(s.id);
  }
  prodServerId = (
    await prisma.server.create({
      data: { hostname: "rbr-prod.example.com", ip: "203.0.113.50", username: "ops", environment: "production" },
    })
  ).id;
  await setLicense("pro");
});

beforeEach(() => {
  // POST /runs is limited to 10/min per user; this file makes more than that.
  resetRateLimits();
});

afterAll(async () => {
  await prisma.runbookRun.deleteMany({ where: { runbook: { name: { startsWith: "rbr-" } } } });
  await prisma.runbook.deleteMany({ where: { name: { startsWith: "rbr-" } } });
  await prisma.server.deleteMany({ where: { hostname: { startsWith: "rbr-" } } });
  await prisma.systemLicense.deleteMany({});
});

describe("authoring", () => {
  it("is admin-only", async () => {
    const res = await call("editor", "POST", "/runbooks", { name: "rbr-editor", script: "id", targetSelector: { serverIds } });
    expect(res.status).toBe(403);
    const rb = await createRunbook();
    expect((await call("editor", "PATCH", `/runbooks/${rb.id}`, { script: "id" })).status).toBe(403);
    expect((await call("editor", "DELETE", `/runbooks/${rb.id}`)).status).toBe(403);
    // …but editors can read and run.
    expect((await call("editor", "GET", `/runbooks/${rb.id}`)).status).toBe(200);
  });

  it("refuses an empty target selector", async () => {
    const res = await call("admin", "POST", "/runbooks", { name: "rbr-empty", script: "id", targetSelector: {} });
    expect(res.status).toBe(400);
    const rb = await createRunbook();
    expect((await call("admin", "PATCH", `/runbooks/${rb.id}`, { targetSelector: { excludeServerIds: [1] } })).status).toBe(400);
  });

  it("refuses a schedule on a runbook that requires approval, including via PATCH", async () => {
    const bad = await call("admin", "POST", "/runbooks", {
      name: "rbr-sched",
      script: "id",
      targetSelector: { serverIds },
      requireApproval: true,
      schedule: "0 3 * * *",
    });
    expect(bad.status).toBe(400);
    const rb = await createRunbook({ requireApproval: true });
    expect((await call("admin", "PATCH", `/runbooks/${rb.id}`, { schedule: "0 3 * * *" })).status).toBe(400);
  });

  it("bumps the version when what runs changes, not for cosmetic edits", async () => {
    const rb = await createRunbook();
    expect(rb.version).toBe(1);
    const cosmetic = await call("admin", "PATCH", `/runbooks/${rb.id}`, { description: "notes" });
    expect(cosmetic.body.version).toBe(1);
    const real = await call("admin", "PATCH", `/runbooks/${rb.id}`, { script: "echo changed\n" });
    expect(real.body.version).toBe(2);
  });

  it("rejects a duplicate name with 409 and frees the name on delete", async () => {
    const rb = await createRunbook();
    expect((await call("admin", "POST", "/runbooks", { name: rb.name, script: "id", targetSelector: { serverIds } })).status).toBe(409);
    expect((await call("admin", "DELETE", `/runbooks/${rb.id}`)).status).toBe(200);
    expect((await call("admin", "GET", `/runbooks/${rb.id}`)).status).toBe(404);
    expect((await call("admin", "POST", "/runbooks", { name: rb.name, script: "id", targetSelector: { serverIds } })).status).toBe(201);
  });

  it("never returns scheduled secret values", async () => {
    const rb = await createRunbook({
      parameters: [{ name: "TOKEN", type: "secret", required: true }],
      schedule: "0 3 * * *",
      scheduleEnabled: true,
      scheduleParams: { TOKEN: "sched-secret-value" },
    });
    const got = await call("admin", "GET", `/runbooks/${rb.id}`);
    expect(got.body.scheduleParams).toEqual({ TOKEN: "***" });
    expect(got.body.nextScheduledAt).not.toBeNull();
    const stored = await prisma.runbook.findUniqueOrThrow({ where: { id: rb.id } });
    expect(stored.scheduleParamsEnc?.startsWith("v3.")).toBe(true);
    // Echoing the mask back keeps the stored value.
    await call("admin", "PATCH", `/runbooks/${rb.id}`, { scheduleParams: { TOKEN: "***" } });
    const after = await prisma.runbook.findUniqueOrThrow({ where: { id: rb.id } });
    expect(after.scheduleParamsEnc).not.toBeNull();
    expect(JSON.stringify(await call("admin", "GET", `/runbooks`))).not.toContain("sched-secret-value");
  });
});

describe("license", () => {
  it("a free license refuses authoring and running", async () => {
    const rb = await createRunbook();
    await setLicense("free");
    try {
      expect((await call("admin", "POST", "/runbooks", { name: "rbr-free", script: "id", targetSelector: { serverIds } })).status).toBe(403);
      expect((await call("admin", "POST", `/runbooks/${rb.id}/runs`, {})).status).toBe(403);
    } finally {
      await setLicense("pro");
    }
  });
});

describe("running and approval", () => {
  it("an editor running a root runbook waits for approval", async () => {
    const rb = await createRunbook({ runAs: "root" });
    const res = await call("editor", "POST", `/runbooks/${rb.id}/runs`, {});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.targetServerIds).toEqual(serverIds);
    const hosts = await prisma.runbookHostResult.findMany({ where: { runId: res.body.id } });
    expect(hosts.map((h) => h.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("an editor running a non-root runbook without requireApproval is queued", async () => {
    const rb = await createRunbook();
    const res = await call("editor", "POST", `/runbooks/${rb.id}/runs`, {});
    expect(res.body.status).toBe("queued");
    expect(res.body.triggeredBy).toBe("user");
  });

  it("an admin's root run is queued; an editor's dry run of it needs no approval", async () => {
    const rb = await createRunbook({ runAs: "root" });
    expect((await call("admin", "POST", `/runbooks/${rb.id}/runs`, {})).body.status).toBe("queued");
    expect((await call("editor", "POST", `/runbooks/${rb.id}/runs`, { dryRun: true })).body.status).toBe("queued");
  });

  it("four eyes: an admin cannot approve their own run, a second admin can", async () => {
    const rb = await createRunbook({ requireApproval: true });
    const run = await call("admin", "POST", `/runbooks/${rb.id}/runs`, {});
    expect(run.body.status).toBe("pending_approval");

    const self = await call("admin", "POST", `/runbook-runs/${run.body.id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("SELF_APPROVAL");

    const other = await call("admin2", "POST", `/runbook-runs/${run.body.id}/approve`);
    expect(other.status).toBe(200);
    expect(other.body.status).toBe("queued");
    expect(other.body.approvedBy.email).toBe("admin2@inventory.local");

    expect((await call("admin2", "POST", `/runbook-runs/${run.body.id}/approve`)).status).toBe(409);
  });

  it("editors cannot approve", async () => {
    const rb = await createRunbook({ runAs: "root" });
    const run = await call("editor", "POST", `/runbooks/${rb.id}/runs`, {});
    expect((await call("editor", "POST", `/runbook-runs/${run.body.id}/approve`)).status).toBe(403);
    expect((await call("admin", "POST", `/runbook-runs/${run.body.id}/approve`)).status).toBe(200);
  });

  it("reject and pending-count", async () => {
    const rb = await createRunbook({ requireApproval: true });
    const run = await call("editor", "POST", `/runbooks/${rb.id}/runs`, {});
    const count = await call("admin", "GET", "/runbook-runs/pending-count");
    expect(count.body.count).toBeGreaterThanOrEqual(1);
    const rej = await call("admin", "POST", `/runbook-runs/${run.body.id}/reject`, { reason: "not now" });
    expect(rej.body.status).toBe("rejected");
    expect(rej.body.rejectionReason).toBe("not now");
    const hosts = await prisma.runbookHostResult.findMany({ where: { runId: run.body.id } });
    expect(hosts.every((h) => h.status === "skipped")).toBe(true);
  });

  it("validates parameters and audits their names, never their values", async () => {
    const rb = await createRunbook({
      parameters: [
        { name: "VERSION", type: "string", required: true, pattern: "[0-9.]+" },
        { name: "TOKEN", type: "secret", required: true },
      ],
    });
    expect((await call("editor", "POST", `/runbooks/${rb.id}/runs`, { params: { TOKEN: "t" } })).status).toBe(400);
    expect((await call("editor", "POST", `/runbooks/${rb.id}/runs`, { params: { VERSION: "1; id", TOKEN: "t" } })).status).toBe(400);
    expect((await call("editor", "POST", `/runbooks/${rb.id}/runs`, { params: { VERSION: "1", TOKEN: "t", PATH: "/x" } })).status).toBe(400);

    const ok = await call("editor", "POST", `/runbooks/${rb.id}/runs`, { params: { VERSION: "1.2", TOKEN: "audit-secret-xyz" } });
    expect(ok.status).toBe(201);
    expect(ok.body.params).toEqual({ VERSION: "1.2", TOKEN: "***" });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "runbook.run_request", entityId: String(ok.body.id) },
    });
    expect(audit.category).toBe("security");
    expect(audit.afterJson).toContain("TOKEN");
    expect(audit.afterJson).toContain("scriptSha256");
    expect(audit.afterJson).not.toContain("audit-secret-xyz");
  });

  it("target overrides may only narrow", async () => {
    const rb = await createRunbook();
    const wider = await call("editor", "POST", `/runbooks/${rb.id}/runs`, { targets: { serverIds: [serverIds[0], prodServerId] } });
    expect(wider.status).toBe(400);
    const narrow = await call("editor", "POST", `/runbooks/${rb.id}/runs`, { targets: { serverIds: [serverIds[1]] } });
    expect(narrow.status).toBe(201);
    expect(narrow.body.targetServerIds).toEqual([serverIds[1]]);

    const locked = await createRunbook({ allowTargetOverride: false });
    expect((await call("editor", "POST", `/runbooks/${locked.id}/runs`, { targets: { serverIds: [serverIds[1]] } })).status).toBe(403);
  });

  it("previews targets with the approval and confirmation hints", async () => {
    const rb = await createRunbook({ runAs: "root", targetSelector: { serverIds: [...serverIds, prodServerId] } });
    const res = await call("editor", "POST", `/runbooks/${rb.id}/preview-targets`, {});
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.requiresApproval).toBe(true);
    expect(res.body.requiresConfirmation).toBe(true);
    const adminView = await call("admin", "POST", `/runbooks/${rb.id}/preview-targets`, {});
    expect(adminView.body.requiresApproval).toBe(false);
  });
});

describe("cancel, output and rerun", () => {
  it("cancels a queued run; only the requester or an admin may", async () => {
    const rb = await createRunbook();
    const run = await call("admin", "POST", `/runbooks/${rb.id}/runs`, {});
    expect((await call("editor", "POST", `/runbook-runs/${run.body.id}/cancel`)).status).toBe(403);
    const res = await call("admin", "POST", `/runbook-runs/${run.body.id}/cancel`);
    expect(res.body.status).toBe("cancelled");
    expect((await call("admin", "POST", `/runbook-runs/${run.body.id}/cancel`)).status).toBe(409);
  });

  it("flags a running run for cancellation instead of flipping it", async () => {
    const rb = await createRunbook();
    const run = await call("editor", "POST", `/runbooks/${rb.id}/runs`, {});
    await prisma.runbookRun.update({ where: { id: run.body.id }, data: { status: "running", claimedBy: "elsewhere" } });
    const res = await call("editor", "POST", `/runbook-runs/${run.body.id}/cancel`);
    expect(res.body.status).toBe("running");
    expect(res.body.cancelRequestedAt).not.toBeNull();
  });

  it("returns output incrementally by character offset", async () => {
    const rb = await createRunbook();
    const run = await call("editor", "POST", `/runbooks/${rb.id}/runs`, {});
    const sid = serverIds[0]!;
    await prisma.runbookHostResult.updateMany({
      where: { runId: run.body.id, serverId: sid },
      data: { status: "succeeded", stdout: "héllo 🚀\nworld\n", stderr: "warn\n" },
    });

    const detail = await call("editor", "GET", `/runbook-runs/${run.body.id}`);
    expect(detail.body.hosts[0]).not.toHaveProperty("stdout");
    expect(detail.body.hosts.find((h: any) => h.serverId === sid).stdoutLength).toBe(14);
    expect(detail.body.scriptSnapshot).toBe("echo hello\n");

    const first = await call("editor", "GET", `/runbook-runs/${run.body.id}/hosts/${sid}/output`);
    expect(first.body.stdout).toBe("héllo 🚀\nworld\n");
    expect(first.body.stdoutNext).toBe(14);
    expect(first.body.done).toBe(true);

    const tail = await call("editor", "GET", `/runbook-runs/${run.body.id}/hosts/${sid}/output?stdoutFrom=8&stderrFrom=5`);
    expect(tail.body.stdout).toBe("world\n");
    expect(tail.body.stderr).toBe("");
  });

  it("shows approvers the current script when it changed since the request", async () => {
    const rb = await createRunbook({ requireApproval: true });
    const run = await call("editor", "POST", `/runbooks/${rb.id}/runs`, {});
    await call("admin", "PATCH", `/runbooks/${rb.id}`, { script: "echo sneaky\n" });
    const detail = await call("admin", "GET", `/runbook-runs/${run.body.id}`);
    expect(detail.body.scriptSnapshot).toBe("echo hello\n");
    expect(detail.body.currentScript).toBe("echo sneaky\n");
    expect(detail.body.currentVersion).toBe(2);
  });

  it("reruns only the hosts that did not succeed", async () => {
    const rb = await createRunbook();
    const run = await call("editor", "POST", `/runbooks/${rb.id}/runs`, {});
    expect((await call("editor", "POST", `/runbook-runs/${run.body.id}/rerun`, { onlyFailed: true })).status).toBe(409);
    await prisma.runbookRun.update({ where: { id: run.body.id }, data: { status: "partially_failed" } });
    await prisma.runbookHostResult.updateMany({ where: { runId: run.body.id }, data: { status: "succeeded" } });
    await prisma.runbookHostResult.updateMany({ where: { runId: run.body.id, serverId: serverIds[2] }, data: { status: "failed" } });

    const rerun = await call("editor", "POST", `/runbook-runs/${run.body.id}/rerun`, { onlyFailed: true });
    expect(rerun.status).toBe(201);
    expect(rerun.body.targetServerIds).toEqual([serverIds[2]]);
    const full = await call("editor", "POST", `/runbook-runs/${run.body.id}/rerun`, { onlyFailed: false });
    expect(full.body.targetServerIds).toEqual(serverIds);
  });

  it("lists runs newest first with a cursor", async () => {
    const rb = await createRunbook();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await call("editor", "POST", `/runbooks/${rb.id}/runs`, {})).body.id);
    const page = await call("editor", "GET", `/runbook-runs?runbookId=${rb.id}&limit=2`);
    expect(page.body.items.map((r: any) => r.id)).toEqual([ids[2], ids[1]]);
    const next = await call("editor", "GET", `/runbook-runs?runbookId=${rb.id}&limit=2&cursor=${page.body.nextCursor}`);
    expect(next.body.items.map((r: any) => r.id)).toEqual([ids[0]]);
    const list = await call("editor", "GET", "/runbooks");
    expect(list.body.items.find((r: any) => r.id === rb.id).lastRun.id).toBe(ids[2]);
  });

  it("rate-limits run requests per user", async () => {
    const rb = await createRunbook();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call("editor", "POST", `/runbooks/${rb.id}/runs`, { dryRun: true })).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
