import { apiFetch } from "./api";
import type {
  CronTarget,
  HeartbeatConfigResponse,
  HeartbeatCreateInput,
  HeartbeatCreatedResponse,
  HeartbeatDetailResponse,
  HeartbeatDto,
  HeartbeatListResponse,
  HeartbeatMonitorInput,
  HeartbeatMonitorResponse,
  HeartbeatPingsResponse,
  HeartbeatStatus,
  HeartbeatUnmonitorInput,
  HeartbeatUnmonitorResponse,
  HeartbeatUpdateInput,
} from "@inv/shared";

export const heartbeatKeys = {
  all: ["heartbeats"] as const,
  list: (params: { serverId?: number; status?: HeartbeatStatus }) => ["heartbeats", "list", params] as const,
  detail: (id: number) => ["heartbeats", id] as const,
  pings: (id: number) => ["heartbeats", id, "pings"] as const,
  config: ["heartbeats", "config"] as const,
};

export function fetchHeartbeats(params: { serverId?: number; status?: HeartbeatStatus } = {}) {
  const q = new URLSearchParams();
  if (params.serverId) q.set("serverId", String(params.serverId));
  if (params.status) q.set("status", params.status);
  const qs = q.toString();
  return apiFetch<HeartbeatListResponse>(`/api/v1/heartbeats${qs ? `?${qs}` : ""}`);
}

export function fetchHeartbeat(id: number) {
  return apiFetch<HeartbeatDetailResponse>(`/api/v1/heartbeats/${id}`);
}

export function fetchHeartbeatConfig() {
  return apiFetch<HeartbeatConfigResponse>("/api/v1/heartbeats/config");
}

export function fetchHeartbeatPings(id: number, cursor?: number) {
  return apiFetch<HeartbeatPingsResponse>(`/api/v1/heartbeats/${id}/pings${cursor ? `?cursor=${cursor}` : ""}`);
}

/** The input type before zod defaults are applied (what a form actually sends). */
export type HeartbeatCreateBody = Partial<HeartbeatCreateInput> & Pick<HeartbeatCreateInput, "name">;

export function createHeartbeat(input: HeartbeatCreateBody) {
  return apiFetch<HeartbeatCreatedResponse>("/api/v1/heartbeats", { method: "POST", body: JSON.stringify(input) });
}

export function updateHeartbeat(id: number, input: HeartbeatUpdateInput) {
  return apiFetch<{ heartbeat: HeartbeatDto }>(`/api/v1/heartbeats/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteHeartbeat(id: number) {
  return apiFetch<{ ok: true; cronLinked: boolean }>(`/api/v1/heartbeats/${id}`, { method: "DELETE" });
}

export function pauseHeartbeat(id: number) {
  return apiFetch<{ heartbeat: HeartbeatDto }>(`/api/v1/heartbeats/${id}/pause`, { method: "POST", body: "{}" });
}

export function resumeHeartbeat(id: number) {
  return apiFetch<{ heartbeat: HeartbeatDto }>(`/api/v1/heartbeats/${id}/resume`, { method: "POST", body: "{}" });
}

export interface RotateTokenResponse extends HeartbeatCreatedResponse {
  cronRewritten: boolean;
}

export function rotateHeartbeatToken(id: number, opts: { rewriteCron?: boolean; sshPassword?: string } = {}) {
  return apiFetch<RotateTokenResponse>(`/api/v1/heartbeats/${id}/rotate-token`, {
    method: "POST",
    body: JSON.stringify({ rewriteCron: opts.rewriteCron ?? false }),
    ...(opts.sshPassword ? { headers: { "Content-Type": "application/json", "X-SSH-Password": opts.sshPassword } } : {}),
  });
}

/** Body the cron tab sends: zod defaults (grace 300s, no duration) may be omitted. */
export type CronMonitorRequest = Omit<HeartbeatMonitorInput, "graceSeconds" | "measureDuration"> &
  Partial<Pick<HeartbeatMonitorInput, "graceSeconds" | "measureDuration">>;

/**
 * Wrap a crontab entry so it pings a new heartbeat. Called by the server's Cron
 * tab after a save, with the saved content's hash as `baseHash` and the entry's
 * (post-save) line number. Returns the new crontab hash to use as the next baseHash.
 */
export function requestCronMonitor(serverId: number, body: CronMonitorRequest, opts: { sshPassword?: string } = {}) {
  return apiFetch<HeartbeatMonitorResponse>(`/api/v1/servers/${serverId}/cron/monitor`, {
    method: "POST",
    body: JSON.stringify(body),
    ...(opts.sshPassword ? { headers: { "Content-Type": "application/json", "X-SSH-Password": opts.sshPassword } } : {}),
  });
}

export type CronUnmonitorRequest = Omit<HeartbeatUnmonitorInput, "deleteHeartbeat"> & Partial<Pick<HeartbeatUnmonitorInput, "deleteHeartbeat">>;

/** Restore the entry's original command; the heartbeat is paused, or deleted when asked (admin). */
export function requestCronUnmonitor(serverId: number, body: CronUnmonitorRequest, opts: { sshPassword?: string } = {}) {
  return apiFetch<HeartbeatUnmonitorResponse>(`/api/v1/servers/${serverId}/cron/unmonitor`, {
    method: "POST",
    body: JSON.stringify(body),
    ...(opts.sshPassword ? { headers: { "Content-Type": "application/json", "X-SSH-Password": opts.sshPassword } } : {}),
  });
}

/** Structurally the Cron tab's `CronMonitorRequest` (components/cron/cron-tab.tsx). */
export interface CronMonitorChange {
  action: "monitor" | "unmonitor";
  target: CronTarget;
  baseHash: string;
  lineNo: number;
  label?: string;
  heartbeatId?: number;
  monitor: { enabled: boolean; graceSeconds: number; measureDuration: boolean };
}

/**
 * Ready-made `onMonitorRequest` for <CronTab/>:
 *   <CronTab serverId={id} onMonitorRequest={(req) => applyCronMonitorChange(id, req)} />
 * Unmonitoring pauses the heartbeat rather than deleting it (deleting is admin-only).
 */
export function applyCronMonitorChange(serverId: number, req: CronMonitorChange, opts: { sshPassword?: string } = {}) {
  if (req.action === "monitor") {
    return requestCronMonitor(
      serverId,
      {
        target: req.target,
        baseHash: req.baseHash,
        lineNo: req.lineNo,
        graceSeconds: req.monitor.graceSeconds,
        measureDuration: req.monitor.measureDuration,
        ...(req.label ? { name: req.label } : {}),
      },
      opts,
    );
  }
  return requestCronUnmonitor(serverId, { target: req.target, baseHash: req.baseHash, lineNo: req.lineNo }, opts);
}
