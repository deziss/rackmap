import { apiFetch } from "./api";
import type {
  RunbookCreateBody,
  RunbookDto,
  RunbookHostOutputResponse,
  RunbookPreviewTargetsInput,
  RunbookRunDetailDto,
  RunbookRunDto,
  RunbookRunListResponse,
  RunbookRunRequestBody,
  RunbookRunStatus,
  RunbookTargetPreview,
  RunbookUpdateInput,
} from "@inv/shared";

/** Query keys for runbooks. Kept here (not lib/queries.ts) so the feature stays self-contained. */
export const runbookKeys = {
  all: ["runbooks"] as const,
  list: ["runbooks", "list"] as const,
  detail: (id: number) => ["runbooks", id] as const,
  preview: (id: number, serverIds?: number[]) => ["runbooks", id, "preview", serverIds ?? null] as const,
  runs: (params: Record<string, unknown>) => ["runbook-runs", "list", params] as const,
  run: (id: number) => ["runbook-runs", id] as const,
  /** Used by the sidebar approvals badge. */
  pendingCount: ["runbook-runs", "pending-count"] as const,
};

export function fetchRunbooks() {
  return apiFetch<{ items: RunbookDto[] }>("/api/v1/runbooks");
}

export function fetchRunbook(id: number) {
  return apiFetch<RunbookDto>(`/api/v1/runbooks/${id}`);
}

export function createRunbook(input: RunbookCreateBody) {
  return apiFetch<RunbookDto>("/api/v1/runbooks", { method: "POST", body: JSON.stringify(input) });
}

export function updateRunbook(id: number, input: RunbookUpdateInput) {
  return apiFetch<RunbookDto>(`/api/v1/runbooks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteRunbook(id: number) {
  return apiFetch<{ ok: true }>(`/api/v1/runbooks/${id}`, { method: "DELETE" });
}

export function previewRunbookTargets(id: number, input: RunbookPreviewTargetsInput = {}) {
  return apiFetch<RunbookTargetPreview>(`/api/v1/runbooks/${id}/preview-targets`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function requestRunbookRun(id: number, input: RunbookRunRequestBody) {
  return apiFetch<RunbookRunDto>(`/api/v1/runbooks/${id}/runs`, { method: "POST", body: JSON.stringify(input) });
}

export function fetchRunbookRuns(params: { runbookId?: number; status?: RunbookRunStatus; cursor?: number; limit?: number }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return apiFetch<RunbookRunListResponse>(`/api/v1/runbook-runs?${q.toString()}`);
}

export function fetchRunbookRun(id: number) {
  return apiFetch<RunbookRunDetailDto>(`/api/v1/runbook-runs/${id}`);
}

export function fetchRunbookHostOutput(runId: number, serverId: number, from: { stdoutFrom: number; stderrFrom: number }) {
  return apiFetch<RunbookHostOutputResponse>(
    `/api/v1/runbook-runs/${runId}/hosts/${serverId}/output?stdoutFrom=${from.stdoutFrom}&stderrFrom=${from.stderrFrom}`,
  );
}

export function fetchPendingRunbookApprovals() {
  return apiFetch<{ count: number }>("/api/v1/runbook-runs/pending-count");
}

export function approveRunbookRun(id: number) {
  return apiFetch<RunbookRunDto>(`/api/v1/runbook-runs/${id}/approve`, { method: "POST" });
}

export function rejectRunbookRun(id: number, reason?: string) {
  return apiFetch<RunbookRunDto>(`/api/v1/runbook-runs/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
}

export function cancelRunbookRun(id: number) {
  return apiFetch<RunbookRunDto>(`/api/v1/runbook-runs/${id}/cancel`, { method: "POST" });
}

export function rerunRunbookRun(id: number, onlyFailed: boolean) {
  return apiFetch<RunbookRunDto>(`/api/v1/runbook-runs/${id}/rerun`, { method: "POST", body: JSON.stringify({ onlyFailed }) });
}

// ─── Lookups the editor needs (read-only; not part of lib/queries.ts) ────────

export interface NamedRef {
  id: number;
  name: string;
}

export function fetchTagsList() {
  return apiFetch<(NamedRef & { color: string | null })[]>("/api/v1/tags");
}

export function fetchLocationsList() {
  return apiFetch<NamedRef[]>("/api/v1/lookups/locations");
}

/** Strip ANSI escape sequences (colours, cursor movement, OSC titles) before showing output. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}
