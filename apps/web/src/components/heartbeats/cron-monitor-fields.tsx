import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { fetchHeartbeatConfig, heartbeatKeys } from "@/lib/heartbeats-api";
import { useHeartbeatPermissions } from "./heartbeat-status";

/**
 * "Monitor this job" controls, rendered inside the cron entry dialog. The dialog
 * forwards `value` on save; the Cron tab then calls POST /servers/:id/cron/monitor
 * (or /unmonitor) with the saved crontab's hash — see `applyCronMonitorChange` in
 * lib/heartbeats-api.ts.
 */
export interface CronMonitorFieldsProps {
  serverId: number;
  /** Present when editing an existing entry. */
  entry?: { lineNo: number; label?: string; heartbeatId?: number } | null;
  /** Host timezone from the cron snapshot, used for next-run hints. */
  timezone: string;
  /** Monitoring choices the cron dialog forwards on save. */
  value: CronMonitorValue;
  onChange(value: CronMonitorValue): void;
  disabled?: boolean;
}

export interface CronMonitorValue {
  enabled: boolean;
  graceSeconds: number;
  measureDuration: boolean;
}

export const DEFAULT_CRON_MONITOR_VALUE: CronMonitorValue = { enabled: false, graceSeconds: 300, measureDuration: false };

export function CronMonitorFields({ entry, timezone, value, onChange, disabled }: CronMonitorFieldsProps) {
  const perms = useHeartbeatPermissions();
  const { data: config } = useQuery({ queryKey: heartbeatKeys.config, queryFn: fetchHeartbeatConfig, staleTime: 60_000 });

  const monitored = entry?.heartbeatId !== undefined;
  const urlsAvailable = config?.pingUrlsAvailable ?? true;
  // Turning monitoring on needs heartbeat:create and a PUBLIC_BASE_URL; turning it
  // off needs heartbeat:update. Never block switching off.
  const canTurnOn = perms.canCreate && urlsAvailable;
  const switchDisabled = disabled || (value.enabled ? !perms.canUpdate && monitored : !canTurnOn);
  const graceMinutes = Math.round((value.graceSeconds / 60) * 100) / 100;

  return (
    <div className="rounded-md border border-white/10 bg-white/3 p-2.5 space-y-2.5">
      <label className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium">Monitor this job</div>
          <div className="text-[11px] text-muted-foreground">
            Each run pings RackMap with its exit code; you are alerted when it fails or stops running on schedule ({timezone}).
          </div>
        </div>
        <Switch checked={value.enabled} disabled={switchDisabled} onCheckedChange={(enabled) => onChange({ ...value, enabled })} />
      </label>

      {!urlsAvailable && !monitored && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>
            This instance has no <code className="font-mono">PUBLIC_BASE_URL</code>, so jobs have no URL to ping. Set it to RackMap's externally reachable address to enable monitoring.
          </span>
        </div>
      )}
      {urlsAvailable && !perms.canCreate && !monitored && (
        <p className="text-[11px] text-muted-foreground">Monitoring a job needs the heartbeat:create permission.</p>
      )}

      {monitored && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {value.enabled
              ? "Grace period and alerting are managed on the heartbeat."
              : "Saving restores the original command and pauses the heartbeat."}
          </span>
          <Link
            to="/heartbeats/$heartbeatId"
            params={{ heartbeatId: String(entry!.heartbeatId) }}
            className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
          >
            Heartbeat #{entry!.heartbeatId} <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      )}

      {value.enabled && !monitored && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <div className="space-y-1">
            <div className="text-[11px] font-medium">Grace period (minutes)</div>
            <Input
              type="number"
              min={0}
              step="any"
              className="h-8 text-xs"
              value={Number.isFinite(graceMinutes) ? graceMinutes : ""}
              disabled={disabled}
              onChange={(e) => {
                const minutes = Number(e.target.value);
                onChange({ ...value, graceSeconds: Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes * 60) : 0 });
              }}
            />
            <div className="text-[10px] text-muted-foreground">How late a run may be before it counts as missed.</div>
          </div>
          <label className="flex items-start gap-2 pt-5">
            <Checkbox
              checked={value.measureDuration}
              disabled={disabled}
              onCheckedChange={(v) => onChange({ ...value, measureDuration: v === true })}
              className="mt-0.5"
            />
            <div>
              <div className="text-[11px] font-medium">Measure duration</div>
              <div className="text-[10px] text-muted-foreground">Also ping when the run starts, so run times are recorded and a hung job is caught.</div>
            </div>
          </label>
          <p className="sm:col-span-2 text-[10px] text-muted-foreground">
            The command is wrapped so it reports its exit code (about 200 extra characters; cron lines are limited to 990). The host must be able to reach this RackMap instance over HTTP(S).
          </p>
        </div>
      )}
    </div>
  );
}
