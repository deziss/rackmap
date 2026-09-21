import { prisma } from "../db.js";
import { env } from "../env.js";
import { fetchMetrics } from "./metrics.service.js";
import { formatStorageBytes } from "./discovery.service.js";
import { notifyMetricAlert } from "./notify.service.js";
import { withJobLock } from "./job-lock.service.js";
import pLimit from "p-limit";

/**
 * Its own lease, separate from the ping scheduler's: this sweep runs on its own
 * 5-minute timer and is an independent workload, so it is fine — preferable,
 * even — for one replica to own the ping sweep while another owns this one.
 */
const LOCK_NAME = "alert:metrics";

// Keep state in memory to avoid alert spam
interface AlertState {
  cpuHigh: boolean;
  ramHigh: boolean;
  diskFull: boolean;
  gpuCount: number;
  disks: string[];
}

const state = new Map<number, AlertState>();
let running = false;
/** Last failure message per server, so a persistent fault is logged once, not every interval. */
const lastFailureReason = new Map<number, string>();
let timer: ReturnType<typeof setInterval> | null = null;

async function checkServer(server: { id: number; hostname: string; ip: string }) {
  try {
    const metrics = await fetchMetrics(server.id);
    const prev = state.get(server.id) || {
      cpuHigh: false,
      ramHigh: false,
      diskFull: false,
      gpuCount: metrics.gpus.length,
      disks: metrics.disks.map((d) => d.mount),
    };

    const next: AlertState = {
      cpuHigh: false,
      ramHigh: false,
      diskFull: false,
      gpuCount: metrics.gpus.length,
      disks: metrics.disks.map((d) => d.mount),
    };

    // Auto calculate and store total storage if not yet set in database
    if (metrics.disks && metrics.disks.length > 0) {
      try {
        const s = await prisma.server.findUnique({ where: { id: server.id }, select: { disk: true } });
        if (s && !s.disk) {
          const totalBytes = metrics.disks.reduce((acc, d) => acc + (d.totalBytes || 0), 0);
          if (totalBytes > 0) {
            await prisma.server.update({ where: { id: server.id }, data: { disk: formatStorageBytes(totalBytes) } });
          }
        }
      } catch {}
    }

    // CPU Check
    const cpuPct = (metrics.cpu.loadAvg1 / metrics.cpu.cores) * 100;
    if (cpuPct >= env.ALERT_THRESHOLD_CPU) {
      next.cpuHigh = true;
      if (!prev.cpuHigh) {
        await notifyMetricAlert("highCpu", server, `CPU Load is at ${Math.round(cpuPct)}% (Threshold: ${env.ALERT_THRESHOLD_CPU}%)`);
      }
    }

    // RAM Check
    const ramPct = metrics.mem.totalMb > 0 ? (metrics.mem.usedMb / metrics.mem.totalMb) * 100 : 0;
    if (ramPct >= env.ALERT_THRESHOLD_RAM) {
      next.ramHigh = true;
      if (!prev.ramHigh) {
        await notifyMetricAlert("ramFull", server, `RAM Usage is at ${Math.round(ramPct)}% (Threshold: ${env.ALERT_THRESHOLD_RAM}%)`);
      }
    }

    // Disk Full Check
    const maxDiskPct = metrics.disks.length > 0 ? Math.max(0, ...metrics.disks.map((d) => d.pct)) : 0;
    if (maxDiskPct >= env.ALERT_THRESHOLD_DISK) {
      next.diskFull = true;
      if (!prev.diskFull) {
        const fullDisks = metrics.disks.filter((d) => d.pct >= env.ALERT_THRESHOLD_DISK).map((d) => `${d.mount} (${d.pct}%)`);
        await notifyMetricAlert("diskFull", server, `Disk Full: ${fullDisks.join(", ")}`);
      }
    }

    // Disk Unmounted Check
    if (state.has(server.id)) {
      const missingDisks = prev.disks.filter((d) => !next.disks.includes(d));
      if (missingDisks.length > 0) {
        await notifyMetricAlert("diskUnmounted", server, `Disks unmounted: ${missingDisks.join(", ")}`);
      }
    }

    // GPU Count Changed
    if (state.has(server.id) && prev.gpuCount !== next.gpuCount) {
      await notifyMetricAlert("gpuCountChanged", server, `GPU count changed from ${prev.gpuCount} to ${next.gpuCount}`);
    }

    state.set(server.id, next);
  } catch (err) {
    // SSH failures are expected when a host is simply down — the TCP status
    // probe already reports that, so this does not alert. But swallowing the
    // error entirely meant a server whose credentials had rotated silently
    // stopped being checked forever, with nothing in the logs. Record it at a
    // low volume instead: once per server per run, not per failure.
    const message = err instanceof Error ? err.message : String(err);
    if (lastFailureReason.get(server.id) !== message) {
      lastFailureReason.set(server.id, message);
      console.warn(`[alert] metrics check failed for ${server.hostname} (${server.ip}): ${message}`);
    }
    return;
  }

  // Recovered — allow the next failure to be logged again.
  lastFailureReason.delete(server.id);
}

export async function runMetricsAlerts() {
  if (running || !env.METRICS_ALERT_ENABLED) return;
  running = true;
  try {
    // `running` only guards overlap inside this process. Across replicas the
    // database lease decides who sweeps; the others skip this round quietly.
    // A full sweep can take 30-45s against a large fleet, longer than any
    // sensible TTL — withJobLock renews the lease while it runs.
    await withJobLock(LOCK_NAME, env.JOB_LOCK_TTL_MS, async () => {
      // `deletedAt: null` matters: without it, soft-deleted servers were still
      // being SSH-polled every interval, long after an operator removed them.
      const servers = await prisma.server.findMany({
        where: { deletedAt: null },
        select: { id: true, hostname: true, ip: true },
      });
      const limit = pLimit(env.PING_CONCURRENCY);
      await Promise.allSettled(servers.map((s) => limit(() => checkServer(s))));
    });
  } catch (err) {
    console.error("[alert] run error:", err);
  } finally {
    running = false;
  }
}

export function startAlertScheduler() {
  if (!env.METRICS_ALERT_ENABLED) return;
  console.log(`[alert] starting — interval ${env.METRICS_ALERT_INTERVAL_MS}ms`);
  
  // Stagger startup so it doesn't run concurrently with the first ping wave
  setTimeout(() => {
    runMetricsAlerts().finally(() => {
      timer = setInterval(runMetricsAlerts, env.METRICS_ALERT_INTERVAL_MS);
    });
  }, 15_000);
}

export function stopAlertScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
