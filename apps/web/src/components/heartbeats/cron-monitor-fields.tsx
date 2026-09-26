/**
 * Slot rendered inside the cron entry dialog. The heartbeats feature fills it
 * in; until then it renders nothing.
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

export function CronMonitorFields(_props: CronMonitorFieldsProps) {
  return null;
}
