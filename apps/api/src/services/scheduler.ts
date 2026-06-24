import { env } from "../env.js";
import { runAll, pruneStatusHistory } from "./status.service.js";
import { runAllServices } from "./service-status.service.js";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tick() {
  if (running) return; // overlap guard
  running = true;
  try {
    await runAll();
    await runAllServices();
    await pruneStatusHistory();
  } catch (err) {
    console.error("[scheduler] error:", err);
  } finally {
    running = false;
    if (timer !== null) {
      // reschedule only if not stopped
      timer = setTimeout(tick, env.PING_INTERVAL_MS);
    }
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
