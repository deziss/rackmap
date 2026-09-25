import { apiFetch } from "./api";
import type {
  CronHostSnapshotDto,
  CronRunInput,
  CronRunResponse,
  CronSaveInput,
  CronSaveResponse,
  CronTarget,
  CronTargetSnapshotDto,
} from "@inv/shared";

export const cronKeys = {
  snapshot: (serverId: number) => ["servers", serverId, "cron"] as const,
};

export function fetchServerCron(serverId: number) {
  return apiFetch<CronHostSnapshotDto>(`/api/v1/servers/${serverId}/cron`);
}

export function saveServerCron(serverId: number, input: CronSaveInput) {
  return apiFetch<CronSaveResponse>(`/api/v1/servers/${serverId}/cron`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function runServerCronEntry(serverId: number, input: CronRunInput) {
  return apiFetch<CronRunResponse>(`/api/v1/servers/${serverId}/cron/run`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Stable key for a target, e.g. "user:root", "system", "crond:backup". */
export function cronTargetKey(t: CronTarget): string {
  if (t.kind === "user") return `user:${t.user}`;
  if (t.kind === "crond") return `crond:${t.file}`;
  return "system";
}

export function cronTargetTitle(t: CronTarget): string {
  if (t.kind === "user") return t.user;
  if (t.kind === "crond") return t.file;
  return "/etc/crontab";
}

export function cronTargetPath(t: CronTarget): string {
  if (t.kind === "user") return `crontab -u ${t.user}`;
  if (t.kind === "crond") return `/etc/cron.d/${t.file}`;
  return "/etc/crontab";
}

/** Mirrors the API rule: system/cron.d/root, or a user the host reports as root-equivalent. */
export function cronTargetNeedsSudo(s: Pick<CronTargetSnapshotDto, "target" | "privileged">): boolean {
  return s.target.kind !== "user" || s.target.user === "root" || s.privileged;
}
