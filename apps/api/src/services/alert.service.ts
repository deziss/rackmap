import { prisma } from "../db.js";
import { env } from "../env.js";
import { fetchMetrics } from "./metrics.service.js";
import { notifyMetricAlert } from "./notify.service.js";
import pLimit from "p-limit";

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
    // Suppress SSH errors; connection issues are handled by the status ping check
  }
}

export async function runMetricsAlerts() {
  if (running || !env.METRICS_ALERT_ENABLED) return;
  running = true;
  try {
    const servers = await prisma.server.findMany({ select: { id: true, hostname: true, ip: true } });
    const limit = pLimit(env.PING_CONCURRENCY);
    await Promise.allSettled(servers.map((s) => limit(() => checkServer(s))));
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
