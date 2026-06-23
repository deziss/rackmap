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

export const serviceKeys = {
  all: ["services"] as const,
  list: (params: Record<string, unknown>) => ["services", "list", params] as const,
  detail: (id: number) => ["services", id] as const,
};

export function fetchServices(params: Record<string, string | number | boolean | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return apiFetch<any>(`/api/v1/services?${q.toString()}`);
}

export function fetchService(id: number) {
  return apiFetch<any>(`/api/v1/services/${id}`);
}

export function revealServicePassword(id: number) {
  return apiFetch<{ password: string | null }>(`/api/v1/services/${id}/reveal-password`, { method: "POST" });
}

export function checkService(id: number) {
  return apiFetch(`/api/v1/services/${id}/check`, { method: "POST" });
}

export function createService(data: unknown) {
  return apiFetch<any>("/api/v1/services", { method: "POST", body: JSON.stringify(data) });
}

export function updateService(id: number, data: unknown) {
  return apiFetch<any>(`/api/v1/services/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export function deleteService(id: number) {
  return apiFetch(`/api/v1/services/${id}`, { method: "DELETE" });
}

export function fetchMe() {
  return apiFetch<{ id: string; email: string; name: string; role: string; can: Record<string, any>; features: { sshEnabled: boolean } }>("/api/v1/me");
}

export function fetchPreferences() {
  return apiFetch<Record<string, any>>("/api/v1/me/preferences");
}

export function updatePreferences(updates: Record<string, any>) {
  return apiFetch<Record<string, any>>("/api/v1/me/preferences", {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

