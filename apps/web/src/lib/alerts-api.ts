import { apiFetch } from "./api";
import type {
  AlertChannelCreateInput,
  AlertChannelDto,
  AlertChannelListResponse,
  AlertChannelTestResult,
  AlertChannelUpdateInput,
  AlertChannelsInfo,
  AlertDeliveryListResponse,
  AlertDeliveryStatus,
  AlertEventListResponse,
  AlertEventType,
  TestAlertResponse,
} from "@inv/shared";

/** Query keys for alert channels. Kept here (not lib/queries.ts) so this feature owns its cache shape. */
export const alertsKeys = {
  all: ["alert-channels"] as const,
  list: () => ["alert-channels", "list"] as const,
  detail: (id: number) => ["alert-channels", id] as const,
  deliveries: (id: number, status?: AlertDeliveryStatus) => ["alert-channels", id, "deliveries", status ?? "all"] as const,
  events: (type?: AlertEventType) => ["alert-events", type ?? "all"] as const,
  server: (serverId: number) => ["servers", serverId, "alert-channels"] as const,
};

export function fetchAlertChannels() {
  return apiFetch<AlertChannelListResponse>("/api/v1/alert-channels");
}

export function fetchAlertChannel(id: number) {
  return apiFetch<AlertChannelDto>(`/api/v1/alert-channels/${id}`);
}

export function createAlertChannel(input: AlertChannelCreateInput) {
  return apiFetch<AlertChannelDto>("/api/v1/alert-channels", { method: "POST", body: JSON.stringify(input) });
}

export function updateAlertChannel(id: number, input: AlertChannelUpdateInput | { enabled: boolean }) {
  return apiFetch<AlertChannelDto>(`/api/v1/alert-channels/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteAlertChannel(id: number) {
  return apiFetch<{ ok: true }>(`/api/v1/alert-channels/${id}`, { method: "DELETE" });
}

export function testAlertChannel(id: number) {
  return apiFetch<AlertChannelTestResult>(`/api/v1/alert-channels/${id}/test`, { method: "POST" });
}

export function testAlertChannelDraft(input: AlertChannelCreateInput) {
  return apiFetch<AlertChannelTestResult>("/api/v1/alert-channels/test", { method: "POST", body: JSON.stringify(input) });
}

export function fetchAlertDeliveries(id: number, opts: { status?: AlertDeliveryStatus; cursor?: number; limit?: number } = {}) {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.cursor) q.set("cursor", String(opts.cursor));
  if (opts.limit) q.set("limit", String(opts.limit));
  return apiFetch<AlertDeliveryListResponse>(`/api/v1/alert-channels/${id}/deliveries?${q.toString()}`);
}

export function fetchAlertEvents(opts: { type?: AlertEventType; cursor?: number; limit?: number } = {}) {
  const q = new URLSearchParams();
  if (opts.type) q.set("type", opts.type);
  if (opts.cursor) q.set("cursor", String(opts.cursor));
  if (opts.limit) q.set("limit", String(opts.limit));
  return apiFetch<AlertEventListResponse>(`/api/v1/alert-events?${q.toString()}`);
}

export function fetchServerAlertRouting(serverId: number) {
  return apiFetch<AlertChannelsInfo>(`/api/v1/servers/${serverId}/alert-channels`);
}

export function sendServerAlertTest(serverId: number) {
  return apiFetch<TestAlertResponse>(`/api/v1/servers/${serverId}/test-alert`, { method: "POST" });
}

/** Tags and a server picker for Pro routing filters. */
export function fetchAlertFilterTags() {
  return apiFetch<{ id: number; name: string; color: string | null }[]>("/api/v1/tags");
}

export function fetchAlertFilterServers(q: string) {
  const p = new URLSearchParams({ limit: "50" });
  if (q) p.set("q", q);
  return apiFetch<{ items: { id: number; hostname: string; ip: string; environment: string | null }[] }>(`/api/v1/servers?${p.toString()}`);
}
