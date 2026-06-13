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
    prisma.statusCheck.create({
      data: {
        serverId,
        status: result.status,
        latencyMs: result.latencyMs,
        errorCode: result.errorCode,
        checkedAt: now,
      },
    }),
  ]);

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

/** Prune status checks older than STATUS_RETENTION_DAYS. */
export async function pruneStatusHistory() {
  const cutoff = new Date(Date.now() - env.STATUS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.statusCheck.deleteMany({ where: { checkedAt: { lt: cutoff } } });
}
