import { env } from "../env.js";
import { runAll, pruneStatusHistory } from "./status.service.js";
import { runAllServices } from "./service-status.service.js";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tick() {
  if (running) return; // overlap guard
  running = true;
  // Each sub-job is isolated: a single try/catch around all three meant a throw
  // in runAll() also skipped the service sweep and the history prune for that
  // tick, so one failing subsystem quietly stopped two others.
  for (const [name, job] of [
    ["servers", runAll],
    ["services", runAllServices],
    ["prune", pruneStatusHistory],
  ] as const) {
    try {
      await job();
    } catch (err) {
      console.error(`[scheduler] ${name} failed:`, err);
    }
  }

  running = false;
  if (timer !== null) {
    // reschedule only if not stopped
    timer = setTimeout(tick, env.PING_INTERVAL_MS);
  }
}

export function startScheduler() {
  if (!env.SCHEDULER_ENABLED) return;
  console.log(`[scheduler] starting — interval ${env.PING_INTERVAL_MS}ms, concurrency ${env.PING_CONCURRENCY}`);
  timer = setTimeout(tick, env.PING_INTERVAL_MS);
}

export function stopScheduler() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
