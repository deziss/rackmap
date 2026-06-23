import { apiFetch } from "./api";
import type { ServerListResponse, ServerDto, ServerMetricsDto } from "@inv/shared";

export const serverKeys = {
  all: ["servers"] as const,
  list: (params: Record<string, unknown>) => ["servers", "list", params] as const,
  detail: (id: number) => ["servers", id] as const,
  metrics: (id: number) => ["servers", id, "metrics"] as const,
};

export const lookupKeys = {
  list: (type: string) => ["lookups", type] as const,
};

export const systemKeys = {
  me: ["system", "me"] as const,
};

export function fetchServers(params: Record<string, string | number | boolean | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return apiFetch<ServerListResponse>(`/api/v1/servers?${q.toString()}`);
}

export function fetchServer(id: number) {
  return apiFetch<ServerDto>(`/api/v1/servers/${id}`);
}

export function fetchServerMetrics(id: number) {
  return apiFetch<ServerMetricsDto>(`/api/v1/servers/${id}/metrics`);
}

export function revealPassword(id: number) {
  return apiFetch<{ password: string | null }>(`/api/v1/servers/${id}/reveal-password`, { method: "POST" });
}

export function checkServer(id: number) {
  return apiFetch(`/api/v1/servers/${id}/check`, { method: "POST" });
}

export function fetchMe() {
  return apiFetch<{ id: string; email: string; name: string; role: string; can: Record<string, any>; features: { sshEnabled: boolean } }>("/api/v1/me");
}
