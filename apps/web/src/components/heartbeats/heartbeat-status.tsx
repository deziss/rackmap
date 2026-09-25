import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import type { HeartbeatDto, HeartbeatStatus } from "@inv/shared";
import { Badge } from "@/components/ui/badge";
import { describeCronSchedule } from "@/components/cron/cron-describe";
import { fetchMe, systemKeys } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Shared bits for the heartbeat pages: status visuals, schedule text, permissions. */

const DOT: Record<HeartbeatStatus, string> = {
  up: "bg-emerald-500 shadow-[0_0_6px_2px_oklch(0.7_0.2_145_/_0.45)]",
  late: "bg-amber-500 shadow-[0_0_6px_2px_oklch(0.8_0.17_80_/_0.45)]",
  down: "bg-red-500 shadow-[0_0_6px_2px_oklch(0.65_0.22_22_/_0.5)]",
  new: "bg-sky-400",
  paused: "bg-slate-500",
};

const LABEL: Record<HeartbeatStatus, string> = {
  up: "Up",
  late: "Late",
  down: "Down",
  new: "Waiting for first ping",
  paused: "Paused",
};

export function HeartbeatStatusDot({ status, className }: { status: HeartbeatStatus; className?: string }) {
  return (
    <span
      title={LABEL[status]}
      aria-label={LABEL[status]}
      className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", DOT[status], status === "up" && "animate-pulse", className)}
    />
  );
}

export function HeartbeatStatusBadge({ status }: { status: HeartbeatStatus }) {
  const variant = status === "up" ? "success" : status === "late" ? "warning" : status === "down" ? "destructive" : "secondary";
  return (
    <Badge variant={variant} className="text-[10px] px-1.5 py-0 gap-1">
      <HeartbeatStatusDot status={status} className="h-1.5 w-1.5 shadow-none animate-none" />
      {status === "new" ? "New" : LABEL[status]}
    </Badge>
  );
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatSeconds(sec: number | null | undefined): string {
  if (!sec) return "—";
  if (sec % 86400 === 0) return `${sec / 86400} d`;
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

/** "Every 5 minutes (UTC)" / "Every 1 h". */
export function describeHeartbeatSchedule(hb: Pick<HeartbeatDto, "kind" | "schedule" | "timezone" | "periodSeconds">): string {
  if (hb.kind === "period") return `Every ${formatSeconds(hb.periodSeconds)}`;
  if (!hb.schedule) return "—";
  return describeCronSchedule(hb.schedule) ?? hb.schedule;
}

export function useHeartbeatPermissions() {
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 60_000 });
  const can = (me?.can ?? {}) as Record<string, boolean>;
  return {
    canCreate: !!can["heartbeat.create"],
    canUpdate: !!can["heartbeat.update"],
    canDelete: !!can["heartbeat.delete"],
    canCron: !!can["server.cron"],
    canSudo: !!can["server.sudo"],
  };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
