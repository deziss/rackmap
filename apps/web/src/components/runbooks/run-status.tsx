import type { RunbookHostStatus, RunbookRunStatus } from "@inv/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";

const RUN_LABEL: Record<RunbookRunStatus, string> = {
  pending_approval: "Awaiting approval",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  partially_failed: "Partially failed",
  cancelled: "Cancelled",
  rejected: "Rejected",
  expired: "Expired",
};

const RUN_VARIANT: Record<RunbookRunStatus, BadgeProps["variant"]> = {
  pending_approval: "warning",
  queued: "secondary",
  running: "default",
  succeeded: "success",
  failed: "destructive",
  partially_failed: "warning",
  cancelled: "outline",
  rejected: "outline",
  expired: "outline",
};

export function RunStatusBadge({ status, className }: { status: RunbookRunStatus; className?: string }) {
  return (
    <Badge variant={RUN_VARIANT[status] ?? "outline"} className={className}>
      {RUN_LABEL[status] ?? status}
    </Badge>
  );
}

const HOST_VARIANT: Record<RunbookHostStatus, BadgeProps["variant"]> = {
  pending: "outline",
  running: "default",
  succeeded: "success",
  failed: "destructive",
  timed_out: "destructive",
  cancelled: "outline",
  skipped: "outline",
};

export function HostStatusBadge({ status }: { status: RunbookHostStatus }) {
  return <Badge variant={HOST_VARIANT[status] ?? "outline"}>{status.replace("_", " ")}</Badge>;
}

/** Operator-facing explanation for a host error code. */
export const HOST_ERROR_HINTS: Record<string, string> = {
  VAULT_LOCKED: "Password is vault-encrypted and the vault is locked for background jobs (set VAULT_PASSPHRASE or unlock globally).",
  NO_CREDENTIALS: "No usable SSH password or key.",
  NOT_FOUND: "Server was deleted.",
  UNREACHABLE: "Could not connect over SSH.",
  AUTH_FAILED: "SSH authentication failed.",
  HOST_KEY_CHANGED: "Host key does not match the pinned key.",
  UPLOAD_FAILED: "Could not upload the script.",
  SUDO_PASSWORD_REQUIRED: "sudo needs a password and none is stored.",
  SUDO_AUTH_FAILED: "sudo rejected the stored password.",
  SUDO_REQUIRETTY: "sudoers requires a TTY (requiretty).",
  SUDO_NOT_ALLOWED: "The SSH user may not use sudo.",
  NO_INTERPRETER: "The interpreter (bash/sh) was not found.",
  TIMEOUT: "Timed out.",
  CANCELLED: "Cancelled.",
  NONZERO_EXIT: "Script exited with a non-zero status.",
  EXEC_FAILED: "RackMap could not execute the script.",
  EXECUTOR_LOST: "The API instance running this stopped. The command may still be running on the host.",
};

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
