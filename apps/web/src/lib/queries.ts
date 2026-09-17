import { apiFetch } from "./api";
import type {
  ServerListResponse,
  ServerDto,
  ServerMetricsDto,
  ServerHardwareInfo,
  OsUserInfo,
  SudoPermissionInput,
  LogQueryInput,
  LogResponse,
  AtopDatesResponse,
  AtopSnapshotsResponse,
  AtopQueryInput,
  AtopProcess,
  VaultStatusResponse,
  SshKeyInfo,
  AddSshKeyInput,
  SshKeyTestResult,
  AutoUpdateStatus,
  AutoUpdateActionInput,
  AlertChannelsInfo,
  TestAlertResponse,
} from "@inv/shared";

export const serverKeys = {
  all: ["servers"] as const,
  list: (params: Record<string, unknown>) => ["servers", "list", params] as const,
  detail: (id: number) => ["servers", id] as const,
  metrics: (id: number) => ["servers", id, "metrics"] as const,
  osUsers: (id: number) => ["servers", id, "os-users"] as const,
  atopDates: (id: number) => ["servers", id, "atop-dates"] as const,
};

export const sshKeyKeys = {
  all: ["ssh-keys"] as const,
};

export const alertChannelKeys = {
  detail: (id: number) => ["servers", id, "alert-channels"] as const,
};

export const autoUpdateKeys = {
  detail: (id: number) => ["servers", id, "auto-update"] as const,
};

export const vaultKeys = {
  status: ["vault", "status"] as const,
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

export function checkAllServers() {
  return apiFetch<{ checked: number }>("/api/v1/servers/check-all", { method: "POST" });
}

export function autoDiscoverServer(id: number) {
  return apiFetch<{ server: ServerDto; hardware: ServerHardwareInfo }>(`/api/v1/servers/${id}/auto-discover`, {
    method: "POST",
  });
}

export function fetchServerOsUsers(id: number) {
  return apiFetch<{ users: OsUserInfo[] }>(`/api/v1/servers/${id}/os-users`);
}

export function updateServerSudoPermission(id: number, input: SudoPermissionInput) {
  return apiFetch<{ success: boolean; message: string }>(`/api/v1/servers/${id}/os-users/sudo`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function queryServerLogs(id: number, input: LogQueryInput) {
  return apiFetch<LogResponse>(`/api/v1/servers/${id}/logs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchAtopDates(id: number) {
  return apiFetch<AtopDatesResponse>(`/api/v1/servers/${id}/atop/dates`);
}

export function fetchAtopSnapshots(id: number, input: AtopQueryInput) {
  return apiFetch<AtopSnapshotsResponse>(`/api/v1/servers/${id}/atop/snapshots`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchAtopIntervalProcesses(id: number, date: string, time: string) {
  return apiFetch<{ processes: AtopProcess[] }>(`/api/v1/servers/${id}/atop/interval-processes`, {
    method: "POST",
    body: JSON.stringify({ date, time }),
  });
}

// Vault
export function fetchVaultStatus() {
  return apiFetch<VaultStatusResponse>("/api/v1/vault/status");
}

export function initVault(passphrase: string) {
  return apiFetch<{ initialized: boolean; unlocked: boolean }>("/api/v1/vault/init", {
    method: "POST",
    body: JSON.stringify({ passphrase }),
  });
}

export function unlockVault(passphrase: string) {
  return apiFetch<{ unlocked: boolean; expiresAt: string }>("/api/v1/vault/unlock", {
    method: "POST",
    body: JSON.stringify({ passphrase }),
  });
}

export function lockVault() {
  return apiFetch<{ locked: boolean }>("/api/v1/vault/lock", {
    method: "POST",
  });
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

export function checkAllServices() {
  return apiFetch<{ checked: number }>("/api/v1/services/check-all", { method: "POST" });
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

export const sslKeys = {
  all: ["ssl"] as const,
  list: (params: Record<string, unknown>) => ["ssl", "list", params] as const,
};

export function fetchSslList(params: Record<string, string | number | boolean | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return apiFetch<any>(`/api/v1/ssl?${q.toString()}`);
}

export function scanAllSsl() {
  return apiFetch("/api/v1/ssl/scan", { method: "POST" });
}

export function scanSslDomain(id: number) {
  return apiFetch(`/api/v1/ssl/${id}/scan`, { method: "POST" });
}

export function createSslDomain(data: unknown) {
  return apiFetch<any>("/api/v1/ssl", { method: "POST", body: JSON.stringify(data) });
}

export function updateSslDomain(id: number, data: unknown) {
  return apiFetch<any>(`/api/v1/ssl/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export function deleteSslDomain(id: number) {
  return apiFetch(`/api/v1/ssl/${id}`, { method: "DELETE" });
}

// SSH Keys
export function fetchSshKeys() {
  return apiFetch<{ keys: SshKeyInfo[] }>("/api/v1/ssh-keys");
}

export function addSshKey(input: AddSshKeyInput) {
  return apiFetch<SshKeyInfo>("/api/v1/ssh-keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function removeSshKey(id: string) {
  return apiFetch<{ success: boolean; message: string }>(`/api/v1/ssh-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function testServerSshKey(serverId: number) {
  return apiFetch<SshKeyTestResult>(`/api/v1/ssh-keys/test-server/${serverId}`, {
    method: "POST",
  });
}

// Auto-Update (Unattended-Upgrades)
export function fetchAutoUpdateStatus(serverId: number) {
  return apiFetch<AutoUpdateStatus>(`/api/v1/servers/${serverId}/auto-update`);
}

export function updateAutoUpdateStatus(serverId: number, input: AutoUpdateActionInput) {
  return apiFetch<{ success: boolean; message: string }>(`/api/v1/servers/${serverId}/auto-update`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}


// Alert Channels & Test Dispatcher
export function fetchServerAlertChannels(serverId: number) {
  return apiFetch<AlertChannelsInfo>(`/api/v1/servers/${serverId}/alert-channels`);
}

export function sendServerTestAlert(serverId: number) {
  return apiFetch<TestAlertResponse>(`/api/v1/servers/${serverId}/test-alert`, {
    method: "POST",
  });
}
