import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  HEARTBEAT_PING_PATH,
  HeartbeatCronSource,
  type HeartbeatConfigResponse,
  type HeartbeatDto,
  type HeartbeatKind,
  type HeartbeatPingKind,
  type HeartbeatPingSummary,
  type HeartbeatStatus,
} from "@inv/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { encryptSecret, decryptSecretDetailed } from "../lib/crypto.js";
import { emitAlert, type AlertEventInput } from "./alerting/emit.js";
import { withJobLock, INSTANCE_ID } from "./job-lock.service.js";

/**
 * Heartbeats: tokens, DTOs, alerting and the background sweep.
 *
 * The ping path (heartbeat-ping.service.ts) moves a heartbeat forward when a job
 * checks in; the sweep here moves it to `late` / `down` when one does not. Both
 * sides raise alerts only on a status EDGE, and both make that edge conditional on
 * the row still being in the state they read — so a ping that lands while the
 * sweep is deciding always wins, and two replicas can never both alert.
 */

// ─── Tokens and URLs ─────────────────────────────────────────────────────────

export interface HeartbeatTokenMaterial {
  token: string;
  tokenHash: string;
  tokenEnc: string;
  tokenPrefix: string;
}

/** sha256 hex — the lookup key. The raw token is never stored in clear or used as a map key. */
export function hashHeartbeatToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 32 random bytes as base64url (43 chars), plus what the row stores about it. */
export function generateHeartbeatToken(): HeartbeatTokenMaterial {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashHeartbeatToken(token),
    // v3 app-key envelope, not the vault: the ping URL must stay re-displayable
    // (and cron lines rewritable) while the vault is locked.
    tokenEnc: encryptSecret(token),
    tokenPrefix: token.slice(0, 6),
  };
}

/** Decrypt a stored token; null if the envelope will not open (rotated APP_ENCRYPTION_KEY). */
export function revealHeartbeatToken(tokenEnc: string): string | null {
  const r = decryptSecretDetailed(tokenEnc);
  return r.ok ? r.plaintext : null;
}

/** PUBLIC_BASE_URL without trailing slashes, or null when it is not configured. */
export function getPublicBaseUrl(): string | null {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return base ? base : null;
}

export function buildPingUrl(token: string): string | null {
  const base = getPublicBaseUrl();
  return base ? `${base}${HEARTBEAT_PING_PATH}/${token}` : null;
}

export function getHeartbeatConfig(): HeartbeatConfigResponse {
  const base = getPublicBaseUrl();
  return { pingUrlsAvailable: base !== null, pingBaseUrl: base ? `${base}${HEARTBEAT_PING_PATH}` : null };
}

export const PUBLIC_BASE_URL_WARNING =
  "PUBLIC_BASE_URL is not set, so RackMap cannot build a ping URL for your jobs. Set it to this instance's externally reachable URL (for example https://rackmap.example.com).";

// ─── DTOs ────────────────────────────────────────────────────────────────────

export const heartbeatInclude = {
  server: {
    select: {
      id: true,
      hostname: true,
      ip: true,
      environment: true,
      lastStatus: true,
      deletedAt: true,
      tags: { select: { tagId: true } },
    },
  },
} satisfies Prisma.HeartbeatInclude;

export type HeartbeatWithServer = Prisma.HeartbeatGetPayload<{ include: typeof heartbeatInclude }>;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function parseCronSource(raw: unknown): HeartbeatCronSource | null {
  if (raw === null || raw === undefined) return null;
  const r = HeartbeatCronSource.safeParse(raw);
  return r.success ? r.data : null;
}

export function toHeartbeatDto(hb: HeartbeatWithServer, recentPings?: HeartbeatPingSummary[]): HeartbeatDto {
  return {
    id: hb.id,
    name: hb.name,
    description: hb.description,
    tokenPrefix: hb.tokenPrefix,
    serverId: hb.serverId,
    server: hb.server
      ? { id: hb.server.id, hostname: hb.server.hostname, ip: hb.server.ip, lastStatus: hb.server.lastStatus }
      : null,
    kind: hb.kind as HeartbeatKind,
    schedule: hb.schedule,
    timezone: hb.timezone,
    periodSeconds: hb.periodSeconds,
    graceSeconds: hb.graceSeconds,
    maxRuntimeSeconds: hb.maxRuntimeSeconds,
    status: hb.status as HeartbeatStatus,
    resumeOnPing: hb.resumeOnPing,
    notifyOnLate: hb.notifyOnLate,
    lastPingAt: iso(hb.lastPingAt),
    lastPingKind: (hb.lastPingKind as HeartbeatPingKind | null) ?? null,
    lastStartAt: iso(hb.lastStartAt),
    lastSuccessAt: iso(hb.lastSuccessAt),
    lastFailureAt: iso(hb.lastFailureAt),
    lastExitCode: hb.lastExitCode,
    lastDurationMs: hb.lastDurationMs,
    expectedAt: iso(hb.expectedAt),
    alertAt: iso(hb.alertAt),
    cronSource: parseCronSource(hb.cronSource),
    createdAt: hb.createdAt.toISOString(),
    updatedAt: hb.updatedAt.toISOString(),
    ...(recentPings ? { recentPings } : {}),
  };
}

/** Newest `perHeartbeat` pings for each id, in one query (the list page's sparklines). */
export async function loadRecentPings(ids: number[], perHeartbeat = 30): Promise<Map<number, HeartbeatPingSummary[]>> {
  const out = new Map<number, HeartbeatPingSummary[]>();
  if (ids.length === 0) return out;
  const rows = await prisma.$queryRaw<
    { heartbeatId: number; kind: string; exitCode: number | null; durationMs: number | null; createdAt: Date }[]
  >`
    SELECT "heartbeatId", "kind", "exitCode", "durationMs", "createdAt" FROM (
      SELECT "heartbeatId", "kind", "exitCode", "durationMs", "createdAt",
             row_number() OVER (PARTITION BY "heartbeatId" ORDER BY "createdAt" DESC, "id" DESC) AS rn
      FROM "heartbeat_ping"
      WHERE "heartbeatId" = ANY(${ids}::int[])
    ) x
    WHERE x.rn <= ${perHeartbeat}
    ORDER BY "heartbeatId", "createdAt" DESC`;
  for (const r of rows) {
    const list = out.get(r.heartbeatId) ?? [];
    list.push({ kind: r.kind as HeartbeatPingKind, exitCode: r.exitCode, durationMs: r.durationMs, createdAt: r.createdAt.toISOString() });
    out.set(r.heartbeatId, list);
  }
  return out;
}

/** Latest success/failure — the end of the last completed run. */
export function lastCompletionAt(hb: { lastSuccessAt: Date | null; lastFailureAt: Date | null }): Date | null {
  const a = hb.lastSuccessAt?.getTime() ?? -Infinity;
  const b = hb.lastFailureAt?.getTime() ?? -Infinity;
  const max = Math.max(a, b);
  return Number.isFinite(max) ? new Date(max) : null;
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export type HeartbeatAlertKind = "fail" | "late" | "recover";
export type HeartbeatFailReason = "exit_code" | "fail_signal" | "missed" | "never_pinged" | "runtime_exceeded";

export interface HeartbeatAlert {
  kind: HeartbeatAlertKind;
  reason?: HeartbeatFailReason;
  exitCode?: number | null;
  bodySnippet?: string | null;
}

const BODY_SNIPPET_MAX = 1024;

function describeFailure(hb: HeartbeatWithServer, a: HeartbeatAlert): string {
  switch (a.reason) {
    case "exit_code":
      return `The job exited with code ${a.exitCode}.`;
    case "fail_signal":
      return "The job reported a failure.";
    case "never_pinged":
      return `The job never checked in (first run was expected ${iso(hb.expectedAt) ?? "earlier"}).`;
    case "runtime_exceeded":
      return `The job started at ${iso(hb.lastStartAt)} and did not finish within ${hb.maxRuntimeSeconds ?? hb.graceSeconds}s.`;
    default:
      return `No ping since ${iso(hb.lastPingAt) ?? "creation"}; the next one was expected at ${iso(hb.expectedAt) ?? "?"}.`;
  }
}

/**
 * Raise one heartbeat alert. Callers invoke this only after winning the status
 * transition, so each edge produces exactly one event. Never throws: a failing
 * alert path must not fail the ping that caused it.
 */
export async function emitHeartbeatAlert(hb: HeartbeatWithServer, a: HeartbeatAlert): Promise<void> {
  const host = hb.server && !hb.server.deletedAt ? hb.server : null;
  const where = host ? ` on ${host.hostname}` : "";
  // Worth saying, not worth suppressing: the host being down is the likely cause,
  // but the operator still needs to know the job did not run.
  const hostDown = host?.lastStatus === "down";
  const base = getPublicBaseUrl();
  const payload: Record<string, unknown> = {
    heartbeatId: hb.id,
    name: hb.name,
    kind: hb.kind,
    schedule: hb.schedule,
    timezone: hb.timezone,
    lastPingAt: iso(hb.lastPingAt),
    expectedAt: iso(hb.expectedAt),
    ...(host ? { server: { id: host.id, hostname: host.hostname, ip: host.ip }, hostDown } : {}),
    ...(base ? { url: `${base}/heartbeats/${hb.id}` } : {}),
  };

  let input: AlertEventInput;
  if (a.kind === "recover") {
    input = {
      type: "heartbeat_recover",
      severity: "info",
      action: "resolve",
      title: `Heartbeat "${hb.name}" recovered${where}`,
      summary: "The job checked in successfully again.",
      payload,
    };
  } else if (a.kind === "late") {
    input = {
      type: "heartbeat_late",
      severity: "warning",
      action: "trigger",
      title: `Heartbeat "${hb.name}" is late${where}`,
      summary: `Expected at ${iso(hb.expectedAt)}; it will be marked down at ${iso(hb.alertAt)}.`,
      payload,
    };
  } else {
    const snippet = a.bodySnippet ? a.bodySnippet.slice(0, BODY_SNIPPET_MAX) : null;
    input = {
      type: "heartbeat_fail",
      severity: "error",
      action: "trigger",
      title: `Heartbeat "${hb.name}" is down${where}`,
      summary: describeFailure(hb, a) + (hostDown ? " Note: the host is down." : ""),
      payload: {
        ...payload,
        reason: a.reason ?? "missed",
        ...(a.exitCode !== undefined ? { exitCode: a.exitCode } : {}),
        ...(snippet ? { bodySnippet: snippet } : {}),
      },
    };
  }

  try {
    await emitAlert({
      ...input,
      dedupKey: `rackmap:heartbeat:${hb.id}`,
      heartbeatId: hb.id,
      serverId: host?.id ?? null,
      tagIds: host?.tags.map((t) => t.tagId) ?? [],
      environment: host?.environment ?? null,
    });
  } catch (err) {
    console.error(`[heartbeat] alert for heartbeat ${hb.id} failed:`, err);
  }
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

export interface SweepCandidate {
  id: number;
  from: "new" | "up" | "late";
  to: "late" | "down";
  /** The deadlines the sweep saw; the transition only applies if they are unchanged. */
  expectedAt: Date | null;
  alertAt: Date | null;
  reason?: HeartbeatFailReason;
}

const SWEEP_BATCH = 500;

// A soft-deleted server's heartbeats are skipped (nobody is watching that host any
// more); a hard-deleted one has already nulled serverId and keeps working unlinked.
const serverAlive: Prisma.HeartbeatWhereInput = { OR: [{ serverId: null }, { server: { deletedAt: null } }] };

function failReason(hb: {
  lastStartAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}): HeartbeatFailReason {
  const done = lastCompletionAt(hb);
  if (hb.lastStartAt && (!done || hb.lastStartAt > done)) return "runtime_exceeded";
  if (!done && !hb.lastStartAt) return "never_pinged";
  return "missed";
}

/** What is overdue at `now`. Read-only; applySweepTransition decides who wins. */
export async function findSweepCandidates(now: Date): Promise<SweepCandidate[]> {
  const [late, down] = await Promise.all([
    prisma.heartbeat.findMany({
      where: {
        AND: [
          { status: "up", expectedAt: { lte: now } },
          // Already past the down deadline: go straight to down, no late alert first.
          { OR: [{ alertAt: null }, { alertAt: { gt: now } }] },
          serverAlive,
        ],
      },
      select: { id: true, expectedAt: true, alertAt: true },
      orderBy: { expectedAt: "asc" },
      take: SWEEP_BATCH,
    }),
    prisma.heartbeat.findMany({
      where: { AND: [{ status: { in: ["new", "up", "late"] }, alertAt: { lte: now } }, serverAlive] },
      select: { id: true, status: true, expectedAt: true, alertAt: true, lastStartAt: true, lastSuccessAt: true, lastFailureAt: true },
      orderBy: { alertAt: "asc" },
      take: SWEEP_BATCH,
    }),
  ]);
  return [
    ...late.map((h): SweepCandidate => ({ id: h.id, from: "up", to: "late", expectedAt: h.expectedAt, alertAt: h.alertAt })),
    ...down.map(
      (h): SweepCandidate => ({
        id: h.id,
        from: h.status as "new" | "up" | "late",
        to: "down",
        expectedAt: h.expectedAt,
        alertAt: h.alertAt,
        reason: failReason(h),
      }),
    ),
  ];
}

/**
 * Apply one transition if — and only if — the row is still exactly as the sweep saw
 * it. A ping that landed in between has moved `status`/`alertAt`, so this matches
 * nothing and no alert goes out. Returns whether this caller won.
 */
export async function applySweepTransition(c: SweepCandidate): Promise<boolean> {
  const res = await prisma.heartbeat.updateMany({
    where: {
      id: c.id,
      status: c.from,
      alertAt: c.alertAt,
      ...(c.to === "late" ? { expectedAt: c.expectedAt } : {}),
    },
    data: { status: c.to },
  });
  if (res.count !== 1) return false;

  const hb = await prisma.heartbeat.findUnique({ where: { id: c.id }, include: heartbeatInclude });
  if (!hb) return true;
  if (c.to === "down") {
    await emitHeartbeatAlert(hb, { kind: "fail", reason: c.reason ?? "missed" });
  } else if (hb.notifyOnLate) {
    await emitHeartbeatAlert(hb, { kind: "late" });
  }
  return true;
}

/** One sweep pass. Exported so tests (and a second "replica") can drive it with a fixed `now`. */
export async function runHeartbeatSweep(now: Date = new Date()): Promise<{ late: number; down: number }> {
  const candidates = await findSweepCandidates(now);
  let late = 0;
  let down = 0;
  for (const c of candidates) {
    try {
      if (await applySweepTransition(c)) {
        if (c.to === "late") late++;
        else down++;
      }
    } catch (err) {
      console.error(`[heartbeat] sweep transition for heartbeat ${c.id} failed:`, err);
    }
  }
  return { late, down };
}

/** The sweep under its lease, as the scheduler runs it. `holder` lets tests stand in for a second replica. */
export async function runHeartbeatSweepLocked(now: Date = new Date(), holder: string = INSTANCE_ID) {
  return withJobLock("heartbeat:sweep", env.JOB_LOCK_TTL_MS, () => runHeartbeatSweep(now), { holder });
}

// ─── Prune ───────────────────────────────────────────────────────────────────

/**
 * Keep the newest HEARTBEAT_PING_KEEP pings per heartbeat, and none older than the
 * retention window. One aggregate (no sort, no window) finds the heartbeats with
 * something to drop; each is then trimmed through the (heartbeatId, createdAt)
 * index, so the hourly run never ranks the whole table.
 */
export async function pruneHeartbeatPings(now: Date = new Date()): Promise<{ overflow: number; expired: number }> {
  const keep = env.HEARTBEAT_PING_KEEP;
  const cutoff = new Date(now.getTime() - env.HEARTBEAT_PING_RETENTION_DAYS * 86_400_000);
  const stats = await prisma.$queryRaw<{ heartbeatId: number; pings: number; oldest: Date }[]>`
    SELECT "heartbeatId", count(*)::int AS "pings", min("createdAt") AS "oldest"
    FROM "heartbeat_ping"
    GROUP BY "heartbeatId"`;

  let overflow = 0;
  for (const s of stats) {
    if (s.pings <= keep) continue;
    // Everything from the (keep+1)-th newest down, in the order the detail view
    // uses: createdAt, then id as the tie-break.
    overflow += await prisma.$executeRaw`
      DELETE FROM "heartbeat_ping"
      WHERE "heartbeatId" = ${s.heartbeatId}
        AND ("createdAt", "id") <= (
          SELECT "createdAt", "id" FROM "heartbeat_ping"
          WHERE "heartbeatId" = ${s.heartbeatId}
          ORDER BY "createdAt" DESC, "id" DESC
          OFFSET ${keep} LIMIT 1
        )`;
  }

  const stale = stats.filter((s) => s.oldest < cutoff).map((s) => s.heartbeatId);
  const expired = stale.length
    ? (await prisma.heartbeatPing.deleteMany({ where: { heartbeatId: { in: stale }, createdAt: { lt: cutoff } } })).count
    : 0;
  return { overflow, expired };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

const PRUNE_INTERVAL_MS = 3_600_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastPruneAt = 0;

async function tick() {
  if (running) return; // overlap guard for this process; the lease guards across replicas
  running = true;
  try {
    await withJobLock("heartbeat:sweep", env.JOB_LOCK_TTL_MS, () => runHeartbeatSweep());
    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now();
      await withJobLock("heartbeat:prune", env.JOB_LOCK_TTL_MS, () => pruneHeartbeatPings());
    }
  } catch (err) {
    console.error("[heartbeat] sweep failed:", err);
  } finally {
    running = false;
    if (timer !== null) timer = setTimeout(tick, env.HEARTBEAT_SWEEP_INTERVAL_MS);
  }
}

export function startHeartbeatScheduler(): void {
  if (!env.SCHEDULER_ENABLED || timer !== null) return;
  console.log(`[heartbeat] sweeper starting — interval ${env.HEARTBEAT_SWEEP_INTERVAL_MS}ms`);
  timer = setTimeout(tick, env.HEARTBEAT_SWEEP_INTERVAL_MS);
}

export function stopHeartbeatScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
