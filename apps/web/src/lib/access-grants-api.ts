import type { z } from "zod";
import { apiFetch } from "./api";
import type {
  AccessGrantDto,
  AccessGrantKind,
  AccessGrantListResponse,
  AccessGrantMutationResponse,
  AccessGrantStatus,
  TemporaryKeyCreateInput,
  TemporaryUserCreateInput,
} from "@inv/shared";

/** Client for /api/v1/access-grants (time-boxed temporary accounts and SSH keys). */

export interface AccessGrantListParams {
  serverId?: number;
  status?: AccessGrantStatus;
  kind?: AccessGrantKind;
}

export const accessGrantKeys = {
  all: ["access-grants"] as const,
  list: (params: AccessGrantListParams) => ["access-grants", "list", params] as const,
  detail: (id: number) => ["access-grants", id] as const,
};

/** What a form sends: the zod input (defaults such as onExpiry may be omitted). */
export type TemporaryUserBody = z.input<typeof TemporaryUserCreateInput>;
export type TemporaryKeyBody = z.input<typeof TemporaryKeyCreateInput>;

function withSshPassword(sshPassword?: string): RequestInit {
  return sshPassword ? { headers: { "Content-Type": "application/json", "X-SSH-Password": sshPassword } } : {};
}

export function fetchAccessGrants(params: AccessGrantListParams = {}) {
  const q = new URLSearchParams();
  if (params.serverId) q.set("serverId", String(params.serverId));
  if (params.status) q.set("status", params.status);
  if (params.kind) q.set("kind", params.kind);
  const qs = q.toString();
  return apiFetch<AccessGrantListResponse>(`/api/v1/access-grants${qs ? `?${qs}` : ""}`);
}

export function fetchAccessGrant(id: number) {
  return apiFetch<{ grant: AccessGrantDto }>(`/api/v1/access-grants/${id}`);
}

export function createTemporaryUser(body: TemporaryUserBody, opts: { sshPassword?: string } = {}) {
  return apiFetch<AccessGrantMutationResponse>("/api/v1/access-grants/users", {
    method: "POST",
    body: JSON.stringify(body),
    ...withSshPassword(opts.sshPassword),
  });
}

export function grantTemporaryKey(body: TemporaryKeyBody, opts: { sshPassword?: string } = {}) {
  return apiFetch<AccessGrantMutationResponse>("/api/v1/access-grants/keys", {
    method: "POST",
    body: JSON.stringify(body),
    ...withSshPassword(opts.sshPassword),
  });
}

export function extendAccessGrant(id: number, expiresAt: string, opts: { sshPassword?: string } = {}) {
  return apiFetch<AccessGrantMutationResponse>(`/api/v1/access-grants/${id}/extend`, {
    method: "POST",
    body: JSON.stringify({ expiresAt }),
    ...withSshPassword(opts.sshPassword),
  });
}

export function revokeAccessGrant(id: number, opts: { sshPassword?: string } = {}) {
  return apiFetch<AccessGrantMutationResponse>(`/api/v1/access-grants/${id}/revoke`, {
    method: "POST",
    body: "{}",
    ...withSshPassword(opts.sshPassword),
  });
}
