import { apiFetch } from "./api";
import type {
  DriftAcknowledgeResponse,
  DriftBaselineResponse,
  DriftCategory,
  DriftEventListResponse,
  DriftScanResponse,
  DriftSeverity,
  DriftSummaryResponse,
  ServerDriftResponse,
} from "@inv/shared";

export interface DriftEventsParams {
  status?: "open" | "all";
  serverId?: number;
  severity?: DriftSeverity;
  category?: DriftCategory;
  cursor?: number;
  limit?: number;
}

export const driftKeys = {
  all: ["drift"] as const,
  summary: ["drift", "summary"] as const,
  events: (params: Omit<DriftEventsParams, "cursor">) => ["drift", "events", params] as const,
  server: (serverId: number) => ["drift", "server", serverId] as const,
};

export function fetchDriftSummary() {
  return apiFetch<DriftSummaryResponse>("/api/v1/drift/summary");
}

export function fetchDriftEvents(params: DriftEventsParams = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.serverId) q.set("serverId", String(params.serverId));
  if (params.severity) q.set("severity", params.severity);
  if (params.category) q.set("category", params.category);
  if (params.cursor) q.set("cursor", String(params.cursor));
  if (params.limit) q.set("limit", String(params.limit));
  const qs = q.toString();
  return apiFetch<DriftEventListResponse>(`/api/v1/drift/events${qs ? `?${qs}` : ""}`);
}

export function acknowledgeDriftEvent(id: number) {
  return apiFetch<DriftAcknowledgeResponse>(`/api/v1/drift/events/${id}/acknowledge`, { method: "POST" });
}

export function fetchServerDrift(serverId: number) {
  return apiFetch<ServerDriftResponse>(`/api/v1/servers/${serverId}/drift`);
}

export function scanServerDrift(serverId: number) {
  return apiFetch<DriftScanResponse>(`/api/v1/servers/${serverId}/drift/scan`, { method: "POST" });
}

export function acceptServerDriftBaseline(serverId: number) {
  return apiFetch<DriftBaselineResponse>(`/api/v1/servers/${serverId}/drift/baseline`, { method: "POST" });
}
