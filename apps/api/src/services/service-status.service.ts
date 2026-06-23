import pLimit from "p-limit";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { tcpProbe } from "../lib/tcp-check.js";
import { httpProbe } from "../lib/http-check.js";

/** Check a single service and persist result. */
export async function runServiceCheck(serviceId: number) {
  const service = await prisma.service.findUnique({
    where: { id: serviceId, deletedAt: null },
    select: { id: true, serverIp: true, port: true, healthUrl: true, downStreak: true, notifiedDown: true, lastStatus: true },
  });
  if (!service) return null;

  let result: { status: "up" | "down"; latencyMs: number | null; errorCode: string | null } = {
    status: "down",
    latencyMs: null,
    errorCode: "NO_ENDPOINT",
  };

  if (service.healthUrl) {
    result = await httpProbe(service.healthUrl, env.PING_TIMEOUT_MS);
  } else if (service.serverIp && service.port) {
    const portNum = parseInt(service.port, 10);
    if (!isNaN(portNum)) {
      result = await tcpProbe(service.serverIp, portNum, env.PING_TIMEOUT_MS);
    }
  }

  const now = new Date();
  const isUp = result.status === "up";
  const newStreak = isUp ? 0 : service.downStreak + 1;

  await prisma.service.update({
    where: { id: serviceId },
    data: {
      lastStatus: result.status,
      lastCheckedAt: now,
      lastLatencyMs: result.latencyMs,
      downStreak: newStreak,
      notifiedDown: isUp ? false : service.notifiedDown,
    },
  });

  return { serviceId, ...result };
}

export async function runAllServices() {
  const services = await prisma.service.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  const limit = pLimit(env.PING_CONCURRENCY);
  const results = await Promise.all(services.map((s) => limit(() => runServiceCheck(s.id))));
  return results.filter(Boolean);
}
