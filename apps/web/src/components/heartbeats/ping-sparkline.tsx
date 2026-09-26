import type { HeartbeatPingSummary } from "@inv/shared";
import { formatDuration } from "./heartbeat-status";

/**
 * The last 30 pings as a row of bars: colour by kind, height by run duration
 * (relative to the slowest run shown). Plain inline SVG — one of these per table
 * row, so no chart library.
 */

const COLOR: Record<HeartbeatPingSummary["kind"], string> = {
  success: "#10b981",
  fail: "#ef4444",
  start: "#38bdf8",
  log: "#64748b",
};

const BAR_W = 3;
const GAP = 1;
const H = 18;

export function PingSparkline({ pings, max = 30 }: { pings: HeartbeatPingSummary[]; max?: number }) {
  // API order is newest first; draw oldest → newest, left to right.
  const shown = pings.slice(0, max).reverse();
  if (shown.length === 0) {
    return <span className="text-[11px] text-muted-foreground">No pings yet</span>;
  }
  const slowest = Math.max(1, ...shown.map((p) => p.durationMs ?? 0));
  const width = max * (BAR_W + GAP);
  return (
    <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={`Last ${shown.length} pings`}>
      {shown.map((p, i) => {
        const ratio = p.durationMs !== null ? 0.3 + 0.7 * (p.durationMs / slowest) : p.kind === "log" || p.kind === "start" ? 0.35 : 0.6;
        const h = Math.max(3, Math.round(H * ratio));
        const x = (max - shown.length + i) * (BAR_W + GAP);
        const label = `${p.kind}${p.exitCode !== null ? ` (exit ${p.exitCode})` : ""}${p.durationMs !== null ? ` · ${formatDuration(p.durationMs)}` : ""} · ${new Date(p.createdAt).toLocaleString()}`;
        return (
          <rect key={`${p.createdAt}-${i}`} x={x} y={H - h} width={BAR_W} height={h} rx={0.5} fill={COLOR[p.kind]}>
            <title>{label}</title>
          </rect>
        );
      })}
    </svg>
  );
}
