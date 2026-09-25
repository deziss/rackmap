import { apiFetch } from "./api";
import type {
  SystemdAction,
  SystemdActionResponse,
  SystemdListType,
  SystemdLogsResponse,
  SystemdUnitDetails,
  SystemdUnitListResponse,
} from "@inv/shared";

export const systemdKeys = {
  all: (serverId: number) => ["servers", serverId, "systemd"] as const,
  units: (serverId: number, type: SystemdListType) => ["servers", serverId, "systemd", "units", type] as const,
  unit: (serverId: number, unit: string) => ["servers", serverId, "systemd", "unit", unit] as const,
  logs: (serverId: number, unit: string, lines: number, since: string) =>
    ["servers", serverId, "systemd", "logs", unit, lines, since] as const,
};

function unitPath(serverId: number, unit: string): string {
  return `/api/v1/servers/${serverId}/systemd/units/${encodeURIComponent(unit)}`;
}

export function fetchSystemdUnits(serverId: number, params: { type: SystemdListType; q?: string }) {
  const qs = new URLSearchParams({ type: params.type });
  if (params.q) qs.set("q", params.q);
  return apiFetch<SystemdUnitListResponse>(`/api/v1/servers/${serverId}/systemd/units?${qs.toString()}`);
}

export function fetchSystemdUnit(serverId: number, unit: string) {
  return apiFetch<SystemdUnitDetails>(unitPath(serverId, unit));
}

/** `since` is an ISO date/time or a relative span such as "1h"; "" means no lower bound. */
export function fetchSystemdLogs(serverId: number, unit: string, params: { lines: number; since?: string }) {
  const qs = new URLSearchParams({ lines: String(params.lines) });
  if (params.since) qs.set("since", params.since);
  return apiFetch<SystemdLogsResponse>(`${unitPath(serverId, unit)}/logs?${qs.toString()}`);
}

export function runSystemdAction(serverId: number, unit: string, action: SystemdAction) {
  return apiFetch<SystemdActionResponse>(`${unitPath(serverId, unit)}/action`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}
