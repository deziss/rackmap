import { apiFetch } from "./api";
import type {
  PatchApplyMode,
  PatchApplyResponse,
  PatchFleetScanResponse,
  PatchListResponse,
  PatchSummary,
  ServerPatchStatusDto,
} from "@inv/shared";

export interface PatchListParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  q?: string;
  securityOnly?: boolean;
  rebootRequired?: boolean;
  status?: "ok" | "error" | "unsupported" | "never";
}

export const patchKeys = {
  all: ["patches"] as const,
  list: (params: PatchListParams) => ["patches", "list", params] as const,
  summary: ["patches", "summary"] as const,
  server: (serverId: number) => ["servers", serverId, "patches"] as const,
};

export function fetchPatchList(params: PatchListParams) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === false) continue;
    qs.set(k, String(v));
  }
  return apiFetch<PatchListResponse>(`/api/v1/patches?${qs.toString()}`);
}

export function fetchPatchSummary() {
  return apiFetch<PatchSummary>("/api/v1/patches/summary");
}

/** Queue background scans (every server when `serverIds` is omitted). */
export function scanFleetPatches(serverIds?: number[]) {
  return apiFetch<PatchFleetScanResponse>("/api/v1/patches/scan", {
    method: "POST",
    body: JSON.stringify(serverIds ? { serverIds } : {}),
  });
}

export function fetchServerPatches(serverId: number) {
  return apiFetch<ServerPatchStatusDto | null>(`/api/v1/servers/${serverId}/patches`);
}

/** Scan one server now and wait for the result (refreshes the package index by default). */
export function scanServerPatches(serverId: number, refresh = true) {
  return apiFetch<ServerPatchStatusDto>(`/api/v1/servers/${serverId}/patches/scan`, {
    method: "POST",
    body: JSON.stringify({ refresh }),
  });
}

/** Install updates as root; resolves when the package manager has finished (up to 30 min). */
export function applyServerPatches(serverId: number, mode: PatchApplyMode) {
  return apiFetch<PatchApplyResponse>(`/api/v1/servers/${serverId}/patches/apply`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}
