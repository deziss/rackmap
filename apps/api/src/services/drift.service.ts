import type { Prisma } from "@prisma/client";
import {
  DRIFT_CATEGORIES,
  type DriftCategory,
  type DriftChanges,
  type DriftEventDto,
  type DriftSeverity,
  type DriftSeverityCounts,
  type DriftSnapshotData,
  type DriftSnapshotSummary,
  type ServerDriftResponse,
} from "@inv/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { redact, type AuditCtx, type WriteAuditArgs } from "../lib/audit.js";
import { AppError, notFound } from "../lib/errors.js";
import { connectToServer, SshError, sshErrorToHttp } from "./ssh.service.js";
import {
  describeRemoteFailure,
  execPreferRoot,
  remoteFailureToHttp,
  RemoteFailureError,
  type RemoteScriptResult,
} from "./remote-exec.service.js";
import { emitAlert } from "./alerting/emit.js";
import { DRIFT_SCRIPT, DriftCollectError, parseDriftOutput } from "./drift-collect.js";
import { diffSnapshots, maxSeverity, snapshotHash } from "./drift-diff.js";

/**
 * Configuration drift: snapshot a host, compare it with the server's baseline,
 * record one DriftEvent per changed category and raise one drift_detected alert.
 *
 * - The first snapshot of a server becomes its baseline and raises nothing.
 * - Drift that the previous scan already reported (identical change set against
 *   the same baseline) is not reported again, so an unresolved change does not
 *   create a new event and a new alert every night. Accepting the latest
 *   snapshot as the baseline (acceptBaseline) is how drift is resolved.
 * - When a server's last open event is acknowledged (or covered by an accepted
 *   baseline), a resolve with the same dedupKey closes its drift incident.
 * - The database half of a scan runs under a per-server advisory lock, so a
 *   manual "Scan now" racing the nightly scan cannot create two baselines.
 *   acceptBaseline and acknowledgements take the same lock, so they never act
 *   on a snapshot or an open count that a concurrent scan is about to change.
 */

const SCAN_TIMEOUT_MS = 120_000;
const SCAN_OUTPUT_CAP = 32 * 1024 * 1024;
/** First key of pg_advisory_xact_lock(int, int); the second is the server id. */
const DRIFT_LOCK_NAMESPACE = 0x0d71f7;
const OPEN_EVENTS_LIMIT = 100;

export { DriftCollectError };

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export const DRIFT_EVENT_INCLUDE = {
  server: { select: { id: true, hostname: true } },
  acknowledgedBy: { select: { id: true, name: true, email: true } },
} as const;

type EventRow = Prisma.DriftEventGetPayload<{ include: typeof DRIFT_EVENT_INCLUDE }>;

function asChanges(value: unknown): DriftChanges {
  const v = (value ?? {}) as Partial<DriftChanges>;
  return {
    added: Array.isArray(v.added) ? v.added : [],
    removed: Array.isArray(v.removed) ? v.removed : [],
    changed: Array.isArray(v.changed) ? v.changed : [],
    ...(typeof v.omitted === "number" && v.omitted > 0 ? { omitted: v.omitted } : {}),
  };
}

export function toDriftEventDto(row: EventRow): DriftEventDto {
  return {
    id: row.id,
    serverId: row.serverId,
    server: row.server ? { id: row.server.id, hostname: row.server.hostname } : null,
    category: row.category as DriftCategory,
    severity: row.severity as DriftSeverity,
    summary: row.summary,
    changes: asChanges(row.changes),
    snapshotId: row.snapshotId,
    detectedAt: row.detectedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: row.acknowledgedBy
      ? { id: row.acknowledgedBy.id, name: row.acknowledgedBy.name, email: row.acknowledgedBy.email }
      : null,
  };
}

/** Stored JSON back to a snapshot; anything missing or malformed reads as "not collected". */
export function asSnapshotData(value: unknown): DriftSnapshotData {
  const v = (value && typeof value === "object" ? value : {}) as Partial<DriftSnapshotData>;
  const pick = <K extends keyof DriftSnapshotData>(k: K, ok: (x: unknown) => boolean) =>
    (v[k] !== undefined && v[k] !== null && ok(v[k]) ? v[k] : null) as DriftSnapshotData[K];
  const isObj = (x: unknown) => typeof x === "object" && !Array.isArray(x);
  return {
    v: 1,
    ranAsRoot: v.ranAsRoot === true,
    users: pick("users", Array.isArray),
    groups: pick("groups", isObj),
    sudoers: pick("sudoers", Array.isArray),
    crontabs: pick("crontabs", isObj),
    ports: pick("ports", Array.isArray),
    units: pick("units", Array.isArray),
    authorizedKeys: pick("authorizedKeys", isObj),
    unavailable: isObj(v.unavailable) ? (v.unavailable as DriftSnapshotData["unavailable"]) : {},
    warnings: Array.isArray(v.warnings) ? v.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

function categoryCounts(d: DriftSnapshotData): Record<DriftCategory, number | null> {
  const size = (o: Record<string, unknown> | null) => (o ? Object.keys(o).length : null);
  return {
    users: d.users?.length ?? null,
    groups: d.groups ? Object.values(d.groups).reduce((n, g) => n + g.members.length, 0) : null,
    sudoers: d.sudoers?.length ?? null,
    crontabs: size(d.crontabs),
    ports: d.ports?.length ?? null,
    units: d.units?.length ?? null,
    authorized_keys: d.authorizedKeys ? Object.values(d.authorizedKeys).reduce((n, k) => n + k.length, 0) : null,
  };
}

export function toSnapshotSummary(row: { id: number; takenAt: Date; hash: string; isBaseline: boolean; data: unknown }): DriftSnapshotSummary {
  const d = asSnapshotData(row.data);
  return {
    id: row.id,
    takenAt: row.takenAt.toISOString(),
    hash: row.hash,
    isBaseline: row.isBaseline,
    ranAsRoot: d.ranAsRoot,
    counts: categoryCounts(d),
    unavailable: d.unavailable,
    warnings: d.warnings,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * HTTP mapping for scan failures: SSH errors keep sshErrorToHttp's mapping,
 * transport/timeout keep remoteFailureToHttp's, a script that did not finish is
 * 502. AppErrors (404, license) are the route's onError's business.
 */
export function driftErrorToHttp(err: unknown): { status: 404 | 409 | 502 | 503 | 504; code: string; message: string } {
  if (err instanceof RemoteFailureError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof SshError) {
    const mapped = sshErrorToHttp(err);
    return { status: mapped.status, code: mapped.code ?? "SSH_ERROR", message: mapped.message };
  }
  if (err instanceof DriftCollectError) return { status: 502, code: "DRIFT_SCAN_FAILED", message: err.message };
  const message = (err as { message?: string } | null)?.message || "Drift scan failed";
  return { status: 502, code: "DRIFT_SCAN_FAILED", message };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface DriftScanOptions {
  /** x-ssh-password override from the request. */
  overridePassword?: string;
  /** Snapshots kept per server (baseline included). Defaults to DRIFT_SNAPSHOT_KEEP. */
  snapshotKeep?: number;
}

/** Run the snapshot script on the host and parse it. Never touches the database. */
export async function collectSnapshot(serverId: number, opts: DriftScanOptions = {}): Promise<DriftSnapshotData> {
  const { client, password, passwordUnavailable } = await connectToServer(serverId, opts.overridePassword);
  let result: RemoteScriptResult & { ranAsRoot: boolean };
  try {
    result = await execPreferRoot(client, DRIFT_SCRIPT, password, { timeoutMs: SCAN_TIMEOUT_MS, maxOutputBytes: SCAN_OUTPUT_CAP });
  } finally {
    client.end();
  }
  const failure = remoteFailureToHttp(result, { passwordUnavailable });
  if (failure) throw new RemoteFailureError(failure, `Drift scan failed: ${failure.message}`);
  if (result.stdoutTruncated) {
    throw new DriftCollectError("The drift scan output exceeded the size limit; no snapshot was stored");
  }
  if (result.errorCode) throw new DriftCollectError(`Drift scan failed: ${describeRemoteFailure(result)}`);

  const data = parseDriftOutput(result.stdout);
  if (!data.ranAsRoot && passwordUnavailable === "vault_locked") {
    data.warnings.push("sudo needs the server's password, but the vault is locked: unlock it for a full scan");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Scan = snapshot + compare + events + alert + prune
// ---------------------------------------------------------------------------

export interface DriftScanResult {
  snapshot: DriftSnapshotSummary;
  baselineCreated: boolean;
  events: DriftEventDto[];
  driftedCategories: DriftCategory[];
  alertEventId: number | null;
}

type Tx = Prisma.TransactionClient;

const driftDedupKey = (serverId: number) => `rackmap:drift:${serverId}`;

/** The per-server lock that scans, baseline changes and acknowledgements share; released at commit. */
async function lockServerDrift(tx: Tx, serverId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DRIFT_LOCK_NAMESPACE}::int, ${serverId}::int)`;
}

/** writeAudit's row, written through an interactive transaction (writeAudit only batches). */
function auditInTx(tx: Tx, { ctx, category, action, entity, entityId, after }: Omit<WriteAuditArgs, "before">) {
  const json = after ? JSON.stringify(redact(after)) : null;
  return tx.auditLog.create({
    data: {
      category,
      action,
      entity: entity ?? null,
      entityId: entityId ?? null,
      actorId: ctx.actorId ?? null,
      actorEmail: ctx.actorEmail ?? null,
      afterJson: json,
      diffJson: json,
      ip: ctx.ip ?? null,
    },
  });
}

/** Keep the newest `keep - 1` non-baseline snapshots plus the current baseline. */
async function pruneSnapshots(tx: Tx, serverId: number, keep: number): Promise<number> {
  const stale = await tx.serverSnapshot.findMany({
    where: { serverId, isBaseline: false },
    orderBy: { id: "desc" },
    skip: Math.max(1, keep - 1),
    select: { id: true },
  });
  if (stale.length === 0) return 0;
  const { count } = await tx.serverSnapshot.deleteMany({ where: { id: { in: stale.map((s) => s.id) }, isBaseline: false } });
  return count;
}

/**
 * Snapshot one server and evaluate it against its baseline. Throws SshError /
 * RemoteFailureError / DriftCollectError when the host could not be read (no
 * snapshot is stored then), AppError 404 when the server is gone.
 */
export async function takeSnapshot(serverId: number, opts: DriftScanOptions = {}): Promise<DriftScanResult> {
  const data = await collectSnapshot(serverId, opts);
  const hash = snapshotHash(data);
  const keep = Math.max(2, opts.snapshotKeep ?? env.DRIFT_SNAPSHOT_KEEP);

  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockServerDrift(tx, serverId);
      const server = await tx.server.findUnique({ where: { id: serverId }, select: { id: true, hostname: true, deletedAt: true } });
      if (!server || server.deletedAt) throw notFound("Server");

      const baseline = await tx.serverSnapshot.findFirst({ where: { serverId, isBaseline: true }, orderBy: { id: "desc" } });
      const previous = await tx.serverSnapshot.findFirst({ where: { serverId }, orderBy: { id: "desc" } });
      const snapshot = await tx.serverSnapshot.create({
        data: { serverId, data: data as unknown as Prisma.InputJsonValue, hash, isBaseline: !baseline },
      });

      const created: EventRow[] = [];
      const drifted: DriftCategory[] = [];
      if (baseline) {
        const base = asSnapshotData(baseline.data);
        const diff = diffSnapshots(base, data);
        // The previous scan against this same baseline, to avoid repeating its report.
        const prevDiff = previous && previous.id > baseline.id ? diffSnapshots(base, asSnapshotData(previous.data)) : null;
        for (const category of DRIFT_CATEGORIES) {
          const d = diff.categories[category];
          if (!d) continue;
          drifted.push(category);
          if (prevDiff?.categories[category]?.fingerprint === d.fingerprint) continue;
          created.push(
            await tx.driftEvent.create({
              data: {
                serverId,
                category,
                severity: d.severity,
                summary: d.summary,
                changes: d.changes as unknown as Prisma.InputJsonValue,
                snapshotId: snapshot.id,
              },
              include: DRIFT_EVENT_INCLUDE,
            }),
          );
        }
      }
      await pruneSnapshots(tx, serverId, keep);
      return { server, snapshot, baselineCreated: !baseline, created, drifted };
    },
    { timeout: 30_000, maxWait: 30_000 },
  );

  let alertEventId: number | null = null;
  if (outcome.created.length > 0) {
    const severity = maxSeverity(outcome.created.map((e) => e.severity as DriftSeverity));
    try {
      const { eventId } = await emitAlert({
        type: "drift_detected",
        severity,
        action: "trigger",
        dedupKey: driftDedupKey(serverId),
        title: `Configuration drift on ${outcome.server.hostname}`,
        summary: outcome.created.map((e) => e.summary).join("\n"),
        serverId,
        payload: {
          serverId,
          hostname: outcome.server.hostname,
          snapshotId: outcome.snapshot.id,
          events: outcome.created.map((e) => ({ id: e.id, category: e.category, severity: e.severity })),
        },
      });
      alertEventId = eventId;
    } catch (err) {
      // The events are recorded; a failed fan-out must not fail the scan.
      console.error(`[drift] alert for server ${serverId} failed:`, (err as Error).message);
    }
  }

  return {
    snapshot: toSnapshotSummary(outcome.snapshot),
    baselineCreated: outcome.baselineCreated,
    events: outcome.created.map(toDriftEventDto),
    driftedCategories: outcome.drifted,
    alertEventId,
  };
}

// ---------------------------------------------------------------------------
// Baseline + acknowledgement
// ---------------------------------------------------------------------------

/**
 * Close the server's drift incident: none of its drift is open any more.
 * Callers emit this only when their own acknowledgement emptied the open set,
 * so a server that had nothing open never gets a resolve. Never throws: the
 * acknowledgement is recorded either way.
 */
async function emitDriftResolved(server: { id: number; hostname: string }, summary: string): Promise<void> {
  try {
    await emitAlert({
      type: "drift_detected",
      severity: "info",
      action: "resolve",
      dedupKey: driftDedupKey(server.id),
      title: `Configuration drift on ${server.hostname} resolved`,
      summary,
      serverId: server.id,
      payload: { serverId: server.id, hostname: server.hostname },
    });
  } catch (err) {
    console.error(`[drift] resolve alert for server ${server.id} failed:`, (err as Error).message);
  }
}

/**
 * Make one snapshot (the latest, unless `snapshotId` pins another) the server's
 * only baseline and acknowledge the open events it covers: whatever the host
 * looked like then is, by an admin's decision, normal.
 *
 * The snapshot is chosen under the scan lock, and only events recorded by that
 * snapshot or an older one are acknowledged: drift that a later scan found was
 * never seen by this baseline, so it stays open. Emptying the open set
 * resolves the drift incident.
 */
export async function acceptBaseline(
  serverId: number,
  ctx: AuditCtx,
  opts: { snapshotId?: number } = {},
): Promise<{ baseline: DriftSnapshotSummary; acknowledged: number }> {
  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockServerDrift(tx, serverId);
      const server = await tx.server.findUnique({ where: { id: serverId }, select: { id: true, hostname: true, deletedAt: true } });
      if (!server || server.deletedAt) throw notFound("Server");
      const chosen =
        opts.snapshotId === undefined
          ? await tx.serverSnapshot.findFirst({ where: { serverId }, orderBy: { id: "desc" } })
          : await tx.serverSnapshot.findFirst({ where: { id: opts.snapshotId, serverId } });
      if (!chosen && opts.snapshotId !== undefined) throw notFound("Drift snapshot");
      if (!chosen) throw new AppError("CONFLICT", "This server has no drift snapshot yet: run a scan first", 409);

      await tx.serverSnapshot.updateMany({ where: { serverId, isBaseline: true, id: { not: chosen.id } }, data: { isBaseline: false } });
      const baseline = await tx.serverSnapshot.update({ where: { id: chosen.id }, data: { isBaseline: true } });
      const acked = await tx.driftEvent.updateMany({
        where: {
          serverId,
          acknowledgedAt: null,
          OR: [{ snapshotId: { lte: chosen.id } }, { snapshotId: null, detectedAt: { lte: chosen.takenAt } }],
        },
        data: { acknowledgedAt: new Date(), acknowledgedById: ctx.actorId ?? null },
      });
      const stillOpen = await tx.driftEvent.count({ where: { serverId, acknowledgedAt: null } });
      await auditInTx(tx, {
        ctx,
        category: "security",
        action: "drift.baseline",
        entity: "server",
        entityId: String(serverId),
        after: {
          hostname: server.hostname,
          snapshotId: chosen.id,
          snapshotTakenAt: chosen.takenAt.toISOString(),
          hash: chosen.hash,
          acknowledgedEvents: acked.count,
          openEvents: stillOpen,
        },
      });
      return { server, baseline, acknowledged: acked.count, stillOpen };
    },
    { timeout: 30_000, maxWait: 30_000 },
  );

  if (outcome.acknowledged > 0 && outcome.stillOpen === 0) {
    await emitDriftResolved(
      outcome.server,
      `Snapshot #${outcome.baseline.id} (${outcome.baseline.takenAt.toISOString()}) was accepted as the baseline; no drift is open.`,
    );
  }
  return { baseline: toSnapshotSummary(outcome.baseline), acknowledged: outcome.acknowledged };
}

export async function acknowledgeDriftEvent(id: number, ctx: AuditCtx): Promise<DriftEventDto> {
  const event = await prisma.driftEvent.findFirst({ where: { id, server: { deletedAt: null } }, include: DRIFT_EVENT_INCLUDE });
  if (!event) throw notFound("Drift event");
  if (event.acknowledgedAt) return toDriftEventDto(event);
  // Under the scan lock, so "was this the server's last open event?" cannot
  // race a scan recording new drift or a second acknowledgement.
  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockServerDrift(tx, event.serverId);
      const { count } = await tx.driftEvent.updateMany({
        where: { id, acknowledgedAt: null },
        data: { acknowledgedAt: new Date(), acknowledgedById: ctx.actorId ?? null },
      });
      const row = await tx.driftEvent.findUnique({ where: { id }, include: DRIFT_EVENT_INCLUDE });
      if (!row) throw notFound("Drift event");
      // Acknowledged (or covered by a baseline) while this request waited for the lock.
      if (count === 0) return { row, lastOpen: false };
      await auditInTx(tx, {
        ctx,
        category: "security",
        action: "drift.acknowledge",
        entity: "drift_event",
        entityId: String(id),
        after: {
          serverId: event.serverId,
          hostname: event.server?.hostname ?? null,
          category: event.category,
          severity: event.severity,
          summary: event.summary,
        },
      });
      const open = await tx.driftEvent.count({ where: { serverId: event.serverId, acknowledgedAt: null } });
      return { row, lastOpen: open === 0 };
    },
    { timeout: 30_000, maxWait: 30_000 },
  );

  if (outcome.lastOpen) {
    await emitDriftResolved(event.server, `Every drift event on ${event.server.hostname} has been acknowledged.`);
  }
  return toDriftEventDto(outcome.row);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function emptyCounts(): DriftSeverityCounts {
  return { critical: 0, warning: 0, info: 0, total: 0 };
}

export function addCount(counts: DriftSeverityCounts, severity: string, n: number): void {
  if (severity === "critical" || severity === "warning" || severity === "info") counts[severity] += n;
  counts.total += n;
}

export async function getServerDrift(serverId: number): Promise<ServerDriftResponse> {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true, deletedAt: true } });
  if (!server || server.deletedAt) throw notFound("Server");
  const [baseline, latest, openEvents, grouped] = await Promise.all([
    prisma.serverSnapshot.findFirst({ where: { serverId, isBaseline: true }, orderBy: { id: "desc" } }),
    prisma.serverSnapshot.findFirst({ where: { serverId }, orderBy: { id: "desc" } }),
    prisma.driftEvent.findMany({
      where: { serverId, acknowledgedAt: null },
      orderBy: { id: "desc" },
      take: OPEN_EVENTS_LIMIT,
      include: DRIFT_EVENT_INCLUDE,
    }),
    prisma.driftEvent.groupBy({ by: ["severity"], where: { serverId, acknowledgedAt: null }, _count: { _all: true } }),
  ]);
  const openCounts = emptyCounts();
  for (const g of grouped) addCount(openCounts, g.severity, g._count._all);
  return {
    serverId,
    baseline: baseline ? toSnapshotSummary(baseline) : null,
    latest: latest ? toSnapshotSummary(latest) : null,
    matchesBaseline: baseline && latest ? baseline.hash === latest.hash : null,
    openCounts,
    openEvents: openEvents.map(toDriftEventDto),
  };
}
