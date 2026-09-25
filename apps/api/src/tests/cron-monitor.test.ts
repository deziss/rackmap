import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";

// The crontab transport (SSH, compare-and-set, host backups) belongs to the cron
// service; these tests drive the monitor flow against an in-memory crontab. The
// error mapping (cronErrorToHttp) stays real.
vi.mock("../services/cron.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/cron.service.js")>()),
  readCronTargets: vi.fn(),
  readCronTarget: vi.fn(),
  writeCronTarget: vi.fn(),
}));
// remote_cron is a Pro feature; the free test database would stop every call at 403.
vi.mock("../services/license.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/license.service.js")>()),
  assertFeatureEnabled: vi.fn(async () => {}),
}));

const { createApp } = await import("../app.js");
const { prisma } = await import("../db.js");
const { env } = await import("../env.js");
const { loginAs } = await import("./helpers.js");
const { AppError } = await import("../lib/errors.js");
const cron = await import("../services/cron.service.js");
const { RemoteExecError } = await import("../services/remote-exec.service.js");
const { SshError } = await import("../services/ssh.service.js");
const { generateHeartbeatToken } = await import("../services/heartbeat.service.js");
const { unwrapHeartbeatCommand, parseCrontab } = await import("@inv/shared");

/**
 * Monitoring rewrites a production crontab and creates a heartbeat that will page
 * someone. Both halves must happen or neither: a failed write must not leave a
 * heartbeat that nothing pings, and unmonitor must give back the file as it was.
 */

const readCronTarget = vi.mocked(cron.readCronTarget);
const writeCronTarget = vi.mocked(cron.writeCronTarget);

const app = createApp();
let adminCookie = "";
let editorCookie = "";
let serverId = 0;
let otherServerId = 0;
const BASE = "https://rackmap.example.com";
const baseBefore = env.PUBLIC_BASE_URL;

const CRONTAB = [
  "SHELL=/bin/bash",
  "CRON_TZ=Europe/Berlin",
  "# rackmap: nightly backup",
  "0 2 * * * /usr/local/bin/backup.sh --full",
  "*/5 * * * * echo tick >> /tmp/example.log",
  "@reboot /usr/local/bin/on-boot.sh",
  "",
].join("\n");
// line 4 = backup (labelled), line 5 = tick (no label), line 6 = @reboot

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const USER_TARGET = { kind: "user" as const, user: "deploy" };

function snapshot(content: string, opts: { privileged?: boolean; target?: unknown } = {}) {
  return { target: opts.target ?? USER_TARGET, content, hash: sha(content), privileged: opts.privileged ?? false, timezone: "UTC" } as never;
}

function post(path: string, body: unknown, cookie: string) {
  return app.request(`/api/v1/servers/${serverId}/cron/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  [adminCookie, editorCookie] = await Promise.all([loginAs(app, "admin"), loginAs(app, "editor")]);
  const s = await prisma.server.create({ data: { hostname: "hb-cron-monitor.test", ip: "192.0.2.60", username: "root" } });
  serverId = s.id;
  const o = await prisma.server.create({ data: { hostname: "hb-cron-monitor-other.test", ip: "192.0.2.61", username: "root" } });
  otherServerId = o.id;
});

afterAll(async () => {
  await prisma.heartbeat.deleteMany({ where: { serverId: { in: [serverId, otherServerId] } } });
  await prisma.server.deleteMany({ where: { id: { in: [serverId, otherServerId] } } });
  env.PUBLIC_BASE_URL = baseBefore;
});

beforeEach(() => {
  env.PUBLIC_BASE_URL = BASE;
  readCronTarget.mockReset();
  writeCronTarget.mockReset();
  readCronTarget.mockResolvedValue(snapshot(CRONTAB));
  writeCronTarget.mockImplementation(async (_id, input) => ({ hash: sha(input.content) }));
});

afterEach(async () => {
  await prisma.heartbeat.deleteMany({ where: { serverId: { in: [serverId, otherServerId] } } });
});

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/** A heartbeat created outside the monitor flow, linked (as far as its row says) to `target`. */
async function linkedHeartbeat(onServer: number, target: unknown, originalCommand = "/root/private-job.sh --token=s3cret") {
  const tok = generateHeartbeatToken();
  return prisma.heartbeat.create({
    data: {
      name: "linked elsewhere",
      serverId: onServer,
      kind: "cron",
      schedule: "0 3 * * *",
      timezone: "UTC",
      graceSeconds: 300,
      tokenHash: tok.tokenHash,
      tokenEnc: tok.tokenEnc,
      tokenPrefix: tok.tokenPrefix,
      status: "up",
      cronSource: { target, originalCommand, label: "nightly backup", labelLineInserted: true } as never,
    },
  });
}

/** CRONTAB with the backup job's label line claiming heartbeat `id`. */
const withMarker = (id: number) => CRONTAB.replace("# rackmap: nightly backup\n", `# rackmap: nightly backup hb=${id}\n`);

describe("POST /servers/:id/cron/monitor", () => {
  it("wraps the entry, labels it with the heartbeat id and arms the heartbeat", async () => {
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 4, graceSeconds: 600, measureDuration: true }, editorCookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { heartbeat: { id: number; schedule: string; timezone: string; status: string; expectedAt: string | null; alertAt: string | null }; hash: string; pingUrl: string };

    expect(writeCronTarget).toHaveBeenCalledTimes(1);
    const [calledServer, input] = writeCronTarget.mock.calls[0]!;
    expect(calledServer).toBe(serverId);
    expect(input.baseHash).toBe(sha(CRONTAB));
    expect(input.target).toEqual(USER_TARGET);

    const lines = input.content.split("\n");
    expect(lines[2]).toBe(`# rackmap: nightly backup hb=${body.heartbeat.id}`);
    expect(lines[3]!.startsWith("0 2 * * * ")).toBe(true);
    const unwrapped = unwrapHeartbeatCommand(lines[3]!.slice("0 2 * * * ".length));
    expect(unwrapped).toMatchObject({ command: "/usr/local/bin/backup.sh --full", pingBase: BASE, measureDuration: true });
    // Everything else is untouched.
    expect(lines.slice(0, 2)).toEqual(["SHELL=/bin/bash", "CRON_TZ=Europe/Berlin"]);
    expect(lines[4]).toBe("*/5 * * * * echo tick >> /tmp/example.log");

    // CRON_TZ wins over the host zone; the job is already scheduled, so it is armed.
    expect(body.heartbeat).toMatchObject({ schedule: "0 2 * * *", timezone: "Europe/Berlin", status: "new" });
    expect(body.heartbeat.expectedAt).not.toBeNull();
    expect(new Date(body.heartbeat.alertAt!).getTime() - new Date(body.heartbeat.expectedAt!).getTime()).toBe(600_000);
    expect(body.pingUrl).toBe(`${BASE}/api/v1/ping/${unwrapped!.token}`);
    expect(body.hash).toBe(sha(input.content));

    const row = await prisma.heartbeat.findUniqueOrThrow({ where: { id: body.heartbeat.id } });
    expect(row.cronSource).toMatchObject({ target: USER_TARGET, originalCommand: "/usr/local/bin/backup.sh --full", label: "nightly backup", labelLineInserted: false });
    expect(await prisma.auditLog.count({ where: { action: "server.cron_monitor", entityId: String(serverId) } })).toBeGreaterThan(0);
  });

  it("deletes the new heartbeat when the crontab write fails (CRON_CONFLICT)", async () => {
    writeCronTarget.mockRejectedValue(new AppError("CRON_CONFLICT", "changed on host", 409));
    const before = await prisma.heartbeat.count({ where: { serverId } });
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 5 }, editorCookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CRON_CONFLICT");
    expect(await prisma.heartbeat.count({ where: { serverId } })).toBe(before);
  });

  it("deletes the new heartbeat when the host is unreachable", async () => {
    writeCronTarget.mockRejectedValue(new SshError("unreachable", "connect ETIMEDOUT"));
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 5 }, editorCookie);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("SSH_ERROR");
    expect(await prisma.heartbeat.count({ where: { serverId } })).toBe(0);
    // Connecting failed, so nothing can have been written: no read-back.
    expect(readCronTarget).toHaveBeenCalledTimes(1);
  });

  it("maps sudo failures like the cron editor (409 SUDO_ERROR) and rolls back without a read-back", async () => {
    writeCronTarget.mockRejectedValue(new RemoteExecError("SUDO_PASSWORD_REQUIRED", "sudo: a password is required"));
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 5 }, editorCookie);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("SUDO_ERROR");
    expect(await prisma.heartbeat.count({ where: { serverId } })).toBe(0);
    expect(readCronTarget).toHaveBeenCalledTimes(1);
  });

  it("keeps the heartbeat when the write timed out after the host installed the crontab", async () => {
    let host = CRONTAB;
    readCronTarget.mockImplementation(async () => snapshot(host));
    writeCronTarget.mockImplementation(async (_id, input) => {
      host = input.content;
      throw new RemoteExecError("TIMEOUT", "The script did not finish within 60s");
    });
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { heartbeat: { id: number }; hash: string };
    expect(body.hash).toBe(sha(host));
    expect(host).toContain(`hb=${body.heartbeat.id}`);
    expect(readCronTarget).toHaveBeenCalledTimes(2);
    expect(await prisma.heartbeat.count({ where: { serverId } })).toBe(1);
  });

  it("rolls back with 504 when the write timed out and the host still has the old crontab", async () => {
    writeCronTarget.mockRejectedValue(new RemoteExecError("TIMEOUT", "The script did not finish within 60s"));
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie);
    expect(res.status).toBe(504);
    expect(await errorCode(res)).toBe("REMOTE_EXEC_ERROR");
    expect(readCronTarget).toHaveBeenCalledTimes(2);
    expect(await prisma.heartbeat.count({ where: { serverId } })).toBe(0);
  });

  it("keeps the heartbeat and says so when neither the write nor the read-back can be confirmed", async () => {
    readCronTarget.mockResolvedValueOnce(snapshot(CRONTAB)).mockRejectedValueOnce(new SshError("unreachable", "down"));
    writeCronTarget.mockRejectedValue(new Error("Incomplete output from the host while writing the crontab"));
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string; details: { heartbeatId: number } } };
    expect(body.error.code).toBe("CRON_WRITE_UNCONFIRMED");
    expect(body.error.message).toContain("check the crontab");
    const kept = await prisma.heartbeat.findUniqueOrThrow({ where: { id: body.error.details.heartbeatId } });
    expect(kept.status).toBe("new");
    expect(kept.serverId).toBe(serverId);
  });

  it("replaces a marker that names another server's heartbeat instead of refusing", async () => {
    const foreign = await linkedHeartbeat(otherServerId, USER_TARGET);
    readCronTarget.mockResolvedValue(snapshot(withMarker(foreign.id)));
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(withMarker(foreign.id)), lineNo: 4 }, editorCookie);
    expect(res.status).toBe(201);
    const { heartbeat } = (await res.json()) as { heartbeat: { id: number } };
    expect(writeCronTarget.mock.calls[0]![1].content.split("\n")[2]).toBe(`# rackmap: nightly backup hb=${heartbeat.id}`);

    // A marker naming a heartbeat that IS linked to this target still counts.
    const own = await linkedHeartbeat(serverId, USER_TARGET);
    readCronTarget.mockResolvedValue(snapshot(withMarker(own.id)));
    const again = await post("monitor", { target: USER_TARGET, baseHash: sha(withMarker(own.id)), lineNo: 4 }, editorCookie);
    expect(again.status).toBe(409);
  });

  it("409 PUBLIC_BASE_URL_UNSET before touching the host", async () => {
    env.PUBLIC_BASE_URL = undefined;
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PUBLIC_BASE_URL_UNSET");
    expect(readCronTarget).not.toHaveBeenCalled();
    expect(await prisma.heartbeat.count({ where: { serverId } })).toBe(0);
  });

  it("409 CRON_CONFLICT when the crontab changed since the editor loaded it", async () => {
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha("something older"), lineNo: 4 }, editorCookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CRON_CONFLICT");
    expect(writeCronTarget).not.toHaveBeenCalled();
    expect(await prisma.heartbeat.count({ where: { serverId } })).toBe(0);
  });

  it("refuses @reboot, non-entries and already-monitored lines", async () => {
    expect((await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 6 }, editorCookie)).status).toBe(400);
    expect((await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 1 }, editorCookie)).status).toBe(400);

    const first = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 5 }, editorCookie);
    expect(first.status).toBe(201);
    const written = writeCronTarget.mock.calls[0]![1].content;
    readCronTarget.mockResolvedValue(snapshot(written));
    // Line 5 became the inserted label line; the entry is now line 6.
    const again = await post("monitor", { target: USER_TARGET, baseHash: sha(written), lineNo: 6 }, editorCookie);
    expect(again.status).toBe(409);
    expect(await prisma.heartbeat.count({ where: { serverId } })).toBe(1);
  });

  it("requires server:sudo for root and for root-equivalent users", async () => {
    const root = { kind: "user", user: "root" };
    readCronTarget.mockResolvedValue(snapshot(CRONTAB, { target: root }));
    expect((await post("monitor", { target: root, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie)).status).toBe(403);
    expect(readCronTarget).not.toHaveBeenCalled();

    const system = { kind: "system" };
    expect((await post("monitor", { target: system, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie)).status).toBe(403);

    readCronTarget.mockResolvedValue(snapshot(CRONTAB, { privileged: true }));
    expect((await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie)).status).toBe(403);
    expect(writeCronTarget).not.toHaveBeenCalled();

    readCronTarget.mockResolvedValue(snapshot(CRONTAB, { target: root }));
    expect((await post("monitor", { target: root, baseHash: sha(CRONTAB), lineNo: 4 }, adminCookie)).status).toBe(201);
  });
});

describe("POST /servers/:id/cron/unmonitor", () => {
  async function monitored(lineNo: number) {
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo, measureDuration: lineNo === 5 }, editorCookie);
    expect(res.status).toBe(201);
    const { heartbeat } = (await res.json()) as { heartbeat: { id: number } };
    const content = writeCronTarget.mock.calls.at(-1)![1].content;
    readCronTarget.mockResolvedValue(snapshot(content));
    writeCronTarget.mockClear();
    return { heartbeatId: heartbeat.id, content };
  }

  it("restores both kinds of line byte-for-byte and parks the heartbeat", async () => {
    // Labelled line: the label stays, only hb= goes.
    const a = await monitored(4);
    const ra = await post("unmonitor", { target: USER_TARGET, baseHash: sha(a.content), lineNo: 4 }, editorCookie);
    expect(ra.status).toBe(200);
    expect(writeCronTarget.mock.calls[0]![1].content).toBe(CRONTAB);
    const parked = await prisma.heartbeat.findUniqueOrThrow({ where: { id: a.heartbeatId } });
    expect(parked.status).toBe("paused");
    expect(parked.cronSource).toBeNull();
    expect(parked.alertAt).toBeNull();

    // Unlabelled line: the label line monitoring inserted is removed again.
    readCronTarget.mockResolvedValue(snapshot(CRONTAB));
    writeCronTarget.mockImplementation(async (_id, input) => ({ hash: sha(input.content) }));
    const b = await monitored(5);
    const lines = parseCrontab(b.content, "user");
    const entry = lines.find((l) => l.type === "entry" && l.heartbeatId === b.heartbeatId);
    expect(entry).toBeDefined();
    const rb = await post("unmonitor", { target: USER_TARGET, baseHash: sha(b.content), lineNo: entry!.lineNo }, editorCookie);
    expect(rb.status).toBe(200);
    expect(writeCronTarget.mock.calls[0]![1].content).toBe(CRONTAB);
  });

  it("deleting the heartbeat is admin-only", async () => {
    const m = await monitored(4);
    const denied = await post("unmonitor", { target: USER_TARGET, baseHash: sha(m.content), lineNo: 4, deleteHeartbeat: true }, editorCookie);
    expect(denied.status).toBe(403);
    expect(writeCronTarget).not.toHaveBeenCalled();

    const ok = await post("unmonitor", { target: USER_TARGET, baseHash: sha(m.content), lineNo: 4, deleteHeartbeat: true }, adminCookie);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { heartbeatDeleted: boolean }).heartbeatDeleted).toBe(true);
    expect(await prisma.heartbeat.findUnique({ where: { id: m.heartbeatId } })).toBeNull();
  });

  it("refuses a line that is not monitored", async () => {
    const res = await post("unmonitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 5 }, editorCookie);
    expect(res.status).toBe(400);
    expect(writeCronTarget).not.toHaveBeenCalled();
  });

  it("maps a host timeout to 504", async () => {
    readCronTarget.mockRejectedValue(new RemoteExecError("TIMEOUT", "The script did not finish within 60s"));
    const res = await post("unmonitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie);
    expect(res.status).toBe(504);
    expect(await errorCode(res)).toBe("REMOTE_EXEC_ERROR");
  });

  it("only strips a marker that names another server's or another target's heartbeat", async () => {
    const elsewhere = [
      await linkedHeartbeat(otherServerId, USER_TARGET),
      await linkedHeartbeat(serverId, { kind: "user", user: "other" }),
    ];
    for (const foreign of elsewhere) {
      const content = withMarker(foreign.id);
      readCronTarget.mockResolvedValue(snapshot(content));
      writeCronTarget.mockClear();
      const res = await post("unmonitor", { target: USER_TARGET, baseHash: sha(content), lineNo: 4, deleteHeartbeat: true }, adminCookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ heartbeatId: null, heartbeatDeleted: false });
      // The label stays, the marker goes — and the other heartbeat's command never lands here.
      expect(writeCronTarget.mock.calls[0]![1].content).toBe(CRONTAB);
      const untouched = await prisma.heartbeat.findUniqueOrThrow({ where: { id: foreign.id } });
      expect(untouched.status).toBe("up");
      expect(untouched.cronSource).not.toBeNull();
    }
  });
});

describe("POST /heartbeats/:id/rotate-token {rewriteCron}", () => {
  const rotate = (id: number) =>
    app.request(`/api/v1/heartbeats/${id}/rotate-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: editorCookie },
      body: JSON.stringify({ rewriteCron: true }),
    });
  const tokenHashOf = async (id: number) => (await prisma.heartbeat.findUniqueOrThrow({ where: { id } })).tokenHash;

  /** Monitor line `lineNo` of `base`; the host then holds the monitored crontab. */
  async function monitoredLine(base = CRONTAB, lineNo = 4) {
    readCronTarget.mockResolvedValue(snapshot(base));
    writeCronTarget.mockImplementation(async (_id, input) => ({ hash: sha(input.content) }));
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(base), lineNo }, editorCookie);
    expect(res.status).toBe(201);
    const { heartbeat } = (await res.json()) as { heartbeat: { id: number } };
    const content = writeCronTarget.mock.calls.at(-1)![1].content;
    const line = parseCrontab(content, "user").find((l) => l.type === "entry" && l.heartbeatId === heartbeat.id);
    const oldToken = unwrapHeartbeatCommand(line!.type === "entry" ? line!.command : "")!.token;
    readCronTarget.mockResolvedValue(snapshot(content));
    writeCronTarget.mockClear();
    readCronTarget.mockClear();
    return { id: heartbeat.id, content, oldToken };
  }

  it("maps a sudo failure to 409 SUDO_ERROR and keeps the old token", async () => {
    const m = await monitoredLine();
    writeCronTarget.mockRejectedValue(new RemoteExecError("SUDO_PASSWORD_REQUIRED", "sudo: a password is required"));
    const res = await rotate(m.id);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("SUDO_ERROR");
    expect(await tokenHashOf(m.id)).toBe(sha(m.oldToken));
  });

  it("keeps the new token when the rewrite timed out after landing on the host", async () => {
    const m = await monitoredLine();
    let host = m.content;
    readCronTarget.mockImplementation(async () => snapshot(host));
    writeCronTarget.mockImplementation(async (_id, input) => {
      host = input.content;
      throw new RemoteExecError("TIMEOUT", "The script did not finish within 60s");
    });
    const res = await rotate(m.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; cronRewritten: boolean };
    expect(body.cronRewritten).toBe(true);
    expect(await tokenHashOf(m.id)).toBe(sha(body.token));
    expect(host).toContain(body.token);
  });

  it("restores the old token with 504 when the rewrite timed out and never landed", async () => {
    const m = await monitoredLine();
    writeCronTarget.mockRejectedValue(new RemoteExecError("TIMEOUT", "The script did not finish within 60s"));
    const res = await rotate(m.id);
    expect(res.status).toBe(504);
    expect(readCronTarget).toHaveBeenCalledTimes(2);
    expect(await tokenHashOf(m.id)).toBe(sha(m.oldToken));
  });

  it("keeps the new token and says so when the rewrite cannot be confirmed", async () => {
    const m = await monitoredLine();
    readCronTarget.mockResolvedValueOnce(snapshot(m.content)).mockRejectedValueOnce(new SshError("unreachable", "down"));
    writeCronTarget.mockRejectedValue(new Error("Incomplete output from the host while writing the crontab"));
    const res = await rotate(m.id);
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe("CRON_WRITE_UNCONFIRMED");
    expect(await tokenHashOf(m.id)).not.toBe(sha(m.oldToken));
  });

  it("does not take over a copied line that carries another heartbeat's token", async () => {
    const h = await monitoredLine();
    const g = await monitoredLine(h.content, 5);
    // H's own line is gone; a copy of G's line claims H in its marker.
    const forged = g.content
      .split("\n")
      .filter((l, i, all) => !l.startsWith(`# rackmap: nightly backup hb=${h.id}`) && !all[i - 1]?.startsWith(`# rackmap: nightly backup hb=${h.id}`))
      .join("\n")
      .replace(`hb=${g.id}`, `hb=${h.id}`);
    expect(forged).toContain(g.oldToken);
    readCronTarget.mockResolvedValue(snapshot(forged));
    const res = await rotate(h.id);
    expect(res.status).toBe(409);
    expect(writeCronTarget).not.toHaveBeenCalled();
    expect(await tokenHashOf(h.id)).toBe(sha(h.oldToken));
    expect(await tokenHashOf(g.id)).toBe(sha(g.oldToken));
  });

  it("rewrites the monitored line with the new token; a failed write keeps the old one", async () => {
    const res = await post("monitor", { target: USER_TARGET, baseHash: sha(CRONTAB), lineNo: 4 }, editorCookie);
    const { heartbeat } = (await res.json()) as { heartbeat: { id: number } };
    const content = writeCronTarget.mock.calls[0]![1].content;
    const oldToken = unwrapHeartbeatCommand(content.split("\n")[3]!.slice("0 2 * * * ".length))!.token;
    readCronTarget.mockResolvedValue(snapshot(content));
    writeCronTarget.mockClear();

    const rotate = (cookie: string) =>
      app.request(`/api/v1/heartbeats/${heartbeat.id}/rotate-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ rewriteCron: true }),
      });

    writeCronTarget.mockRejectedValueOnce(new AppError("CRON_CONFLICT", "changed on host", 409));
    expect((await rotate(editorCookie)).status).toBe(409);
    const kept = await prisma.heartbeat.findUniqueOrThrow({ where: { id: heartbeat.id } });
    expect(kept.tokenHash).toBe(sha(oldToken));

    writeCronTarget.mockImplementation(async (_id, input) => ({ hash: sha(input.content) }));
    const r = await rotate(editorCookie);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { token: string; cronRewritten: boolean };
    expect(body.cronRewritten).toBe(true);
    const newLine = writeCronTarget.mock.calls.at(-1)![1].content.split("\n")[3]!;
    expect(unwrapHeartbeatCommand(newLine.slice("0 2 * * * ".length))!.token).toBe(body.token);
    expect(body.token).not.toBe(oldToken);
  });
});
