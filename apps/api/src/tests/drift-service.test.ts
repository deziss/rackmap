import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";

/**
 * drift.service against a fake host: connectToServer and execPreferRoot are
 * mocked, and the mock answers in the marker/base64 protocol the real script
 * prints, built from a small in-memory description of the host.
 */

const mocks = vi.hoisted(() => ({ connectToServer: vi.fn(), execPreferRoot: vi.fn() }));
vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return { ...actual, connectToServer: mocks.connectToServer };
});
vi.mock("../services/remote-exec.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-exec.service.js")>();
  return { ...actual, execPreferRoot: mocks.execPreferRoot };
});

const { prisma } = await import("../db.js");
const { takeSnapshot, acceptBaseline, acknowledgeDriftEvent, getServerDrift, DriftCollectError } = await import(
  "../services/drift.service.js"
);
const { RemoteFailureError } = await import("../services/remote-exec.service.js");
const { DRIFT_SCRIPT } = await import("../services/drift-collect.js");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const OPS_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFT39dUGJD8gU3dDiRMLIq/xfkgS9edCcupNym+2B/3T ops@example.com";
const INTRUDER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHpc1EzfTaQA8EmLd6/40bUwN5xOoJOBSrEwc2FOgt1l intruder@example.com";
const INTRUDER_FP = "SHA256:5l28XdnWBRWawAlkkUyVHPiucQl92iDZdgrn3cwsQhE";

interface FakeHost {
  root: boolean;
  passwd: string;
  group: string;
  sudoers: string;
  crontabs: Record<string, string>;
  ss: string;
  units: string[];
  keys: Record<string, string>;
}

let host: FakeHost;

function freshHost(): FakeHost {
  return {
    root: true,
    passwd: [
      "root:x:0:0:root:/root:/bin/bash",
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
      "ops:x:1000:1000:Ops:/home/ops:/bin/bash",
    ].join("\n"),
    group: ["root:x:0:", "sudo:x:27:ops", "ops:x:1000:"].join("\n"),
    sudoers: "Defaults env_reset\nroot ALL=(ALL:ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\n#includedir /etc/sudoers.d\n",
    crontabs: { system: "17 * * * * root cd / && run-parts --report /etc/cron.hourly\n" },
    ss: 'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))\n',
    units: ["cron.service", "ssh.service"],
    keys: { ops: OPS_KEY },
  };
}

function hostOutput(h: FakeHost): string {
  const na = (c: string) => `===UNAVAILABLE:${c}===\n${b64("needs root")}\n`;
  let out = `===ROOT===\n${h.root ? 1 : 0}\n===PASSWD===\n${b64(h.passwd)}\n===GROUP===\n${b64(h.group)}\n`;
  if (h.root) {
    out += `===SUDOERS===\n${b64(h.sudoers)}\n===CRONTABS===\n\n`;
    for (const [t, content] of Object.entries(h.crontabs)) out += `===CRONH:${t}===\n${sha(content)}\n`;
  } else {
    out += na("sudoers") + na("crontabs");
  }
  out += `===PORTS===\n${b64(h.ss)}\n===UNITS===\n${b64(h.units.map((u) => `${u} enabled enabled`).join("\n"))}\n`;
  if (h.root) {
    out += "===AKEYS===\n\n";
    for (const [u, text] of Object.entries(h.keys)) out += `===AK:${u}===\n${b64(text)}\n`;
  } else {
    out += na("authorized_keys");
  }
  return `${out}===END===\n\n`;
}

function result(stdout: string, extra: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    durationMs: 10,
    ranAsRoot: host.root,
    ...extra,
  };
}

let serverId = 0;
let adminId = "";
const ctx = () => ({ actorId: adminId, actorEmail: "admin@inventory.local", ip: "192.0.2.1" });

beforeAll(async () => {
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@inventory.local" } });
  adminId = admin.id;
});

beforeEach(async () => {
  host = freshHost();
  const s = await prisma.server.create({ data: { hostname: `drift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.example.com`, ip: "192.0.2.70", username: "ops" } });
  serverId = s.id;
  mocks.connectToServer.mockReset().mockImplementation(async () => ({
    client: { end: vi.fn() },
    target: { id: serverId, hostname: s.hostname, ip: s.ip, username: "ops", sshPort: 22 },
    password: undefined,
  }));
  mocks.execPreferRoot.mockReset().mockImplementation(async (_client: unknown, script: string) => {
    expect(script).toBe(DRIFT_SCRIPT);
    return result(hostOutput(host));
  });
});

const alerts = (id: number) => prisma.alertEvent.findMany({ where: { serverId: id, type: "drift_detected" }, orderBy: { id: "asc" } });

describe("takeSnapshot", () => {
  it("stores the first snapshot as the baseline without events or alerts", async () => {
    const r = await takeSnapshot(serverId);
    expect(r.baselineCreated).toBe(true);
    expect(r.events).toEqual([]);
    const snaps = await prisma.serverSnapshot.findMany({ where: { serverId } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.isBaseline).toBe(true);
    expect(snaps[0]!.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.snapshot.counts).toMatchObject({ users: 3, sudoers: 3, crontabs: 1, ports: 1, units: 2, authorized_keys: 1 });
    expect(await alerts(serverId)).toHaveLength(0);
    expect(await prisma.driftEvent.count({ where: { serverId } })).toBe(0);
  });

  it("a new root key raises one critical event and one alert, and is not repeated by the next scan", async () => {
    await takeSnapshot(serverId);
    host.keys.root = INTRUDER_KEY;

    const second = await takeSnapshot(serverId);
    expect(second.baselineCreated).toBe(false);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ category: "authorized_keys", severity: "critical" });
    expect(second.events[0]!.changes.added).toMatchObject([{ key: `root ${INTRUDER_FP}`, severity: "critical" }]);
    expect(second.events[0]!.summary).toMatch(/New authorized key for root/);

    const raised = await alerts(serverId);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: "critical", action: "trigger", dedupKey: `rackmap:drift:${serverId}` });

    // Same drift again: recorded as still drifted, but no new event and no new alert.
    const third = await takeSnapshot(serverId);
    expect(third.events).toEqual([]);
    expect(third.driftedCategories).toEqual(["authorized_keys"]);
    expect(await alerts(serverId)).toHaveLength(1);
    expect(await prisma.driftEvent.count({ where: { serverId } })).toBe(1);

    // A further change is new drift for that category.
    host.units.push("nginx.service");
    host.keys.ops = `${OPS_KEY}\n${INTRUDER_KEY}`;
    const fourth = await takeSnapshot(serverId);
    expect(fourth.events.map((e) => e.category).sort()).toEqual(["authorized_keys", "units"]);
    const latestAlert = (await alerts(serverId)).at(-1)!;
    expect(latestAlert.severity).toBe("critical");
    expect(await alerts(serverId)).toHaveLength(2);
  });

  it("scores each rule: new sudoers rule and privileged member are critical, new port and crontab change warnings", async () => {
    await takeSnapshot(serverId);
    host.passwd += "\nmallory:x:1001:1001::/home/mallory:/bin/bash";
    host.group = host.group.replace("sudo:x:27:ops", "sudo:x:27:ops,mallory");
    host.sudoers += "mallory ALL=(ALL) NOPASSWD: ALL\n";
    host.crontabs.system += "* * * * * root /tmp/x\n";
    host.ss += 'tcp LISTEN 0 128 0.0.0.0:4444 0.0.0.0:* users:(("nc",pid=4242,fd=3))\n';
    const r = await takeSnapshot(serverId);
    const sev = Object.fromEntries(r.events.map((e) => [e.category, e.severity]));
    expect(sev).toEqual({ users: "warning", groups: "critical", sudoers: "critical", crontabs: "warning", ports: "warning" });
  });

  it("a scan without root never reports the categories it could not read as removed", async () => {
    await takeSnapshot(serverId);
    host.root = false;
    const r = await takeSnapshot(serverId);
    expect(r.events).toEqual([]);
    expect(r.snapshot.ranAsRoot).toBe(false);
    expect(Object.keys(r.snapshot.unavailable).sort()).toEqual(["authorized_keys", "crontabs", "sudoers"]);
    expect(r.snapshot.counts.sudoers).toBeNull();
  });

  it("accepting the baseline acknowledges open events and ends the drift", async () => {
    await takeSnapshot(serverId);
    host.keys.root = INTRUDER_KEY;
    const drifted = await takeSnapshot(serverId);
    expect(drifted.events).toHaveLength(1);

    const accepted = await acceptBaseline(serverId, ctx());
    expect(accepted.acknowledged).toBe(1);
    expect(accepted.baseline.isBaseline).toBe(true);
    const baselines = await prisma.serverSnapshot.findMany({ where: { serverId, isBaseline: true } });
    expect(baselines.map((b) => b.id)).toEqual([drifted.snapshot.id]);
    const ev = await prisma.driftEvent.findFirstOrThrow({ where: { serverId } });
    expect(ev.acknowledgedAt).not.toBeNull();
    expect(ev.acknowledgedById).toBe(adminId);
    expect(await prisma.auditLog.count({ where: { action: "drift.baseline", entityId: String(serverId) } })).toBe(1);

    // The incident the scan opened is closed under the same dedupKey.
    const raised = await alerts(serverId);
    expect(raised.map((a) => a.action)).toEqual(["trigger", "resolve"]);
    expect(raised[1]).toMatchObject({ severity: "info", dedupKey: `rackmap:drift:${serverId}`, serverId });

    const again = await takeSnapshot(serverId);
    expect(again.events).toEqual([]);
    expect(again.driftedCategories).toEqual([]);
    const view = await getServerDrift(serverId);
    expect(view.matchesBaseline).toBe(true);
    expect(view.openCounts.total).toBe(0);

    // Nothing was open, so nothing is resolved again.
    expect((await acceptBaseline(serverId, ctx())).acknowledged).toBe(0);
    expect(await alerts(serverId)).toHaveLength(2);
  });

  it("acceptBaseline leaves open the events of a scan newer than the accepted snapshot", async () => {
    await takeSnapshot(serverId);
    host.keys.root = INTRUDER_KEY;
    const reviewed = await takeSnapshot(serverId);
    // A scan commits after the admin picked `reviewed` but before it is accepted.
    host.sudoers += "mallory ALL=(ALL) NOPASSWD: ALL\n";
    const newer = await takeSnapshot(serverId);
    expect(newer.events).toMatchObject([{ category: "sudoers", severity: "critical" }]);

    const accepted = await acceptBaseline(serverId, ctx(), { snapshotId: reviewed.snapshot.id });
    expect(accepted.acknowledged).toBe(1);
    expect(accepted.baseline.id).toBe(reviewed.snapshot.id);
    const baselines = await prisma.serverSnapshot.findMany({ where: { serverId, isBaseline: true } });
    expect(baselines.map((b) => b.id)).toEqual([reviewed.snapshot.id]);
    const byId = new Map((await prisma.driftEvent.findMany({ where: { serverId } })).map((e) => [e.id, e]));
    expect(byId.get(reviewed.events[0]!.id)!.acknowledgedAt).not.toBeNull();
    expect(byId.get(newer.events[0]!.id)!.acknowledgedAt).toBeNull();
    expect((await getServerDrift(serverId)).openCounts).toMatchObject({ critical: 1, total: 1 });
    // Drift is still open: the incident stays open.
    expect((await alerts(serverId)).filter((a) => a.action === "resolve")).toHaveLength(0);

    await acknowledgeDriftEvent(newer.events[0]!.id, ctx());
    expect((await alerts(serverId)).at(-1)).toMatchObject({ action: "resolve", severity: "info", dedupKey: `rackmap:drift:${serverId}` });

    await expect(acceptBaseline(serverId, ctx(), { snapshotId: 2147483647 })).rejects.toMatchObject({ status: 404 });
  });

  it("acknowledging an event is audited and idempotent", async () => {
    await takeSnapshot(serverId);
    host.units.push("nginx.service");
    const { events } = await takeSnapshot(serverId);
    const acked = await acknowledgeDriftEvent(events[0]!.id, ctx());
    expect(acked.acknowledgedAt).not.toBeNull();
    expect(acked.acknowledgedBy?.id).toBe(adminId);
    await acknowledgeDriftEvent(events[0]!.id, ctx());
    expect(await prisma.auditLog.count({ where: { action: "drift.acknowledge", entityId: String(events[0]!.id) } })).toBe(1);
  });

  it("acknowledging the last open event resolves the drift alert, once", async () => {
    await takeSnapshot(serverId);
    host.units.push("nginx.service");
    host.keys.root = INTRUDER_KEY;
    const { events } = await takeSnapshot(serverId);
    expect(events).toHaveLength(2);
    const resolves = async () => (await alerts(serverId)).filter((a) => a.action === "resolve");

    await acknowledgeDriftEvent(events[0]!.id, ctx());
    expect(await resolves()).toHaveLength(0);
    await acknowledgeDriftEvent(events[1]!.id, ctx());
    const [resolved] = await resolves();
    expect(resolved).toMatchObject({ severity: "info", dedupKey: `rackmap:drift:${serverId}`, serverId });
    await acknowledgeDriftEvent(events[1]!.id, ctx());
    expect(await resolves()).toHaveLength(1);
  });

  it("prunes old snapshots but never the baseline", async () => {
    const first = await takeSnapshot(serverId, { snapshotKeep: 3 });
    for (let i = 0; i < 5; i++) {
      host.units.push(`extra${i}.service`);
      await takeSnapshot(serverId, { snapshotKeep: 3 });
    }
    const snaps = await prisma.serverSnapshot.findMany({ where: { serverId }, orderBy: { id: "asc" } });
    expect(snaps).toHaveLength(3);
    expect(snaps[0]!.id).toBe(first.snapshot.id);
    expect(snaps[0]!.isBaseline).toBe(true);
  });

  it("stores nothing when the host cannot be read", async () => {
    mocks.execPreferRoot.mockResolvedValueOnce(result("", { exitCode: null, errorCode: "UPLOAD_FAILED", errorMessage: "channel failed" }));
    await expect(takeSnapshot(serverId)).rejects.toBeInstanceOf(RemoteFailureError);
    mocks.execPreferRoot.mockResolvedValueOnce(result(hostOutput(host).replace("===END===\n\n", "")));
    await expect(takeSnapshot(serverId)).rejects.toBeInstanceOf(DriftCollectError);
    mocks.execPreferRoot.mockResolvedValueOnce(result(hostOutput(host), { stdoutTruncated: true }));
    await expect(takeSnapshot(serverId)).rejects.toBeInstanceOf(DriftCollectError);
    expect(await prisma.serverSnapshot.count({ where: { serverId } })).toBe(0);
  });
});
