import pLimit from "p-limit";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { tcpProbe } from "../lib/tcp-check.js";
import { notifyFlip } from "./notify.service.js";

/** Check a single server and persist result. Returns the probe result. */
export async function runCheck(serverId: number) {
  const server = await prisma.server.findUnique({
    where: { id: serverId, deletedAt: null },
    select: { id: true, ip: true, sshPort: true, hostname: true, downStreak: true, notifiedDown: true, lastStatus: true },
  });
  if (!server) return null;

  const result = await tcpProbe(server.ip, server.sshPort, env.PING_TIMEOUT_MS);
  const now = new Date();

  const isUp = result.status === "up";
  const prevStatus = server.lastStatus;
  const newStreak = isUp ? 0 : server.downStreak + 1;

  const record = shouldRecordCheck(serverId, prevStatus, result.status, now.getTime());
  await prisma.$transaction([
    prisma.server.update({
      where: { id: serverId },
      data: {
        lastStatus: result.status,
        lastCheckedAt: now,
        lastLatencyMs: result.latencyMs,
        downStreak: newStreak,
        notifiedDown: isUp ? false : server.notifiedDown,
      },
    }),
    ...(record
      ? [
          prisma.statusCheck.create({
            data: {
              serverId,
              status: result.status,
              latencyMs: result.latencyMs,
              errorCode: result.errorCode,
              checkedAt: now,
            },
          }),
        ]
      : []),
  ]);
  if (record) lastRecordedAt.set(serverId, now.getTime());

  const flipped = prevStatus !== "unknown" && prevStatus !== result.status;
  const confirmedDown = !isUp && newStreak >= env.STATUS_FLIP_THRESHOLD && !server.notifiedDown;
  const recovered = isUp && prevStatus === "down";

  if (confirmedDown) {
    await prisma.server.update({ where: { id: serverId }, data: { notifiedDown: true } });
    notifyFlip({ serverId, hostname: server.hostname, ip: server.ip, port: server.sshPort, from: "up", to: "down" }).catch(() => {});
  } else if (recovered) {
    notifyFlip({ serverId, hostname: server.hostname, ip: server.ip, port: server.sshPort, from: "down", to: "up" }).catch(() => {});
  }

  return { serverId, ...result, flipped, confirmedDown, recovered };
}

/** Check all non-deleted servers with configured concurrency. */
export async function runAll() {
  const servers = await prisma.server.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  const limit = pLimit(env.PING_CONCURRENCY);
  const results = await Promise.all(servers.map((s) => limit(() => runCheck(s.id))));
  return results.filter(Boolean);
}

/**
 * When each server last had a history row written, so steady-state probes are
 * sampled instead of stored one-for-one. In-process on purpose: the scheduler
 * runs on one replica at a time, and after a restart the first probe simply
 * writes a fresh row.
 */
const lastRecordedAt = new Map<number, number>();

/**
 * Record a probe when the status changed, when this server has no row yet in
 * this process, or when the sample interval has passed since its last row.
 */
export function shouldRecordCheck(
  serverId: number,
  prevStatus: string,
  nextStatus: string,
  nowMs: number,
  intervalMs: number = env.STATUS_SAMPLE_INTERVAL_MS,
): boolean {
  if (intervalMs <= 0 || prevStatus !== nextStatus) return true;
  const last = lastRecordedAt.get(serverId);
  return last === undefined || nowMs - last >= intervalMs;
}

/** Test hook: forget the sampling state. */
export function resetStatusSampling(): void {
  lastRecordedAt.clear();
}

/**
 * Delete history rows by age and/or keep only the newest `keepNewest`.
 * Row ids are assigned in insert order, so "newest" is "highest id".
 */
export async function purgeStatusHistory(opts: { olderThanDays?: number; keepNewest?: number }): Promise<number> {
  let deleted = 0;
  if (opts.olderThanDays !== undefined) {
    const cutoff = new Date(Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000);
    deleted += (await prisma.statusCheck.deleteMany({ where: { checkedAt: { lt: cutoff } } })).count;
  }
  if (opts.keepNewest !== undefined) {
    if (opts.keepNewest === 0) {
      deleted += (await prisma.statusCheck.deleteMany({})).count;
    } else {
      const [boundary] = await prisma.statusCheck.findMany({
        orderBy: { id: "desc" },
        skip: opts.keepNewest - 1,
        take: 1,
        select: { id: true },
      });
      if (boundary) {
        deleted += (await prisma.statusCheck.deleteMany({ where: { id: { lt: boundary.id } } })).count;
      }
    }
  }
  return deleted;
}

/** Prune by STATUS_RETENTION_DAYS, then enforce the STATUS_MAX_ROWS cap. */
export async function pruneStatusHistory() {
  await purgeStatusHistory({
    olderThanDays: env.STATUS_RETENTION_DAYS,
    ...(env.STATUS_MAX_ROWS > 0 ? { keepNewest: env.STATUS_MAX_ROWS } : {}),
  });
}

export async function getStatusHistoryStats() {
  const [agg, servers] = await Promise.all([
    prisma.statusCheck.aggregate({ _count: { _all: true }, _min: { checkedAt: true }, _max: { checkedAt: true } }),
    prisma.statusCheck.groupBy({ by: ["serverId"] }).then((rows) => rows.length),
  ]);
  return {
    total: agg._count._all,
    oldest: agg._min.checkedAt?.toISOString() ?? null,
    newest: agg._max.checkedAt?.toISOString() ?? null,
    servers,
    retentionDays: env.STATUS_RETENTION_DAYS,
    maxRows: env.STATUS_MAX_ROWS,
    sampleIntervalMs: env.STATUS_SAMPLE_INTERVAL_MS,
  };
}
