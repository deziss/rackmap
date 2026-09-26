import type { ReactNode } from "react";
import {
  isValidSystemdUnitName,
  systemdActionNeedsSudo,
  type SystemdAction,
} from "@inv/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const ACTION_LABELS: Record<SystemdAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  reload: "Reload",
  enable: "Enable",
  disable: "Disable",
};

export const ACTION_EFFECTS: Record<SystemdAction, string> = {
  start: "starts the unit now (systemctl start).",
  stop: "stops the unit now; it stays stopped until started again or the host reboots (if enabled).",
  restart: "stops and starts the unit (systemctl restart).",
  reload: "asks the unit to reload its configuration without a restart; fails if it has no reload command.",
  enable: "makes the unit start at boot (systemctl enable); it is not started now.",
  disable: "stops the unit from starting at boot (systemctl disable); it keeps running now.",
};

export const ACTION_ORDER: SystemdAction[] = ["start", "stop", "restart", "reload", "enable", "disable"];

/** Why an action on a unit is unavailable to the current user, or null when it is allowed. */
export function actionBlockedReason(
  unit: string,
  action: SystemdAction,
  opts: { canSudo: boolean; licensed: boolean },
): string | null {
  if (!isValidSystemdUnitName(unit)) return "RackMap cannot act on units with this name";
  if (!opts.licensed) return "Service actions need the systemd Service Manager feature (Pro)";
  if (systemdActionNeedsSudo(unit, action) && !opts.canSudo) return "Protected unit — requires the server:sudo permission";
  return null;
}

export function ActiveBadge({ active, sub }: { active: string; sub?: string }) {
  const variant =
    active === "active"
      ? "success"
      : active === "failed"
        ? "destructive"
        : active === "activating" || active === "deactivating" || active === "reloading"
          ? "warning"
          : "secondary";
  return (
    <Badge variant={variant} className="text-[10px] py-0 px-1.5 font-mono whitespace-nowrap">
      {active}
      {sub ? <span className="opacity-70 ml-1">({sub})</span> : null}
    </Badge>
  );
}

export function EnabledBadge({ state }: { state: string | null }) {
  if (!state) return <span className="text-muted-foreground/60 text-[11px]">—</span>;
  const tone =
    state === "enabled" || state === "enabled-runtime"
      ? "border-emerald-500/30 text-emerald-400"
      : state === "masked" || state === "masked-runtime" || state === "bad"
        ? "border-destructive/40 text-destructive"
        : state === "disabled"
          ? "border-white/10 text-muted-foreground"
          : "border-sky-500/30 text-sky-400";
  return (
    <span className={cn("inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-mono whitespace-nowrap", tone)}>
      {state}
    </span>
  );
}

export function CenteredNote({ icon, text, children }: { icon: ReactNode; text: string; children?: ReactNode }) {
  return (
    <div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground text-xs rounded-xl border text-center px-4">
      {icon}
      <span>{text}</span>
      {children}
    </div>
  );
}

export function formatBytes(n: number | null): string {
  if (n === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
