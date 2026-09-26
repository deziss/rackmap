import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ACCESS_GRANT_DURATION_PRESETS,
  ACCESS_GRANT_MAX_REVOKE_ATTEMPTS,
  accessGrantExpiryError,
  type AccessGrantDto,
} from "@inv/shared";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchMe, systemKeys } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Shared bits for the access-grant screens: permissions, clock, countdown, badges, expiry picker. */

export function useAccessGrantPermissions() {
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 60_000 });
  const can = (me?.can ?? {}) as Record<string, boolean>;
  const canCreate = !!can["accessGrant.create"];
  return {
    loaded: !!me,
    canRead: !!can["accessGrant.read"],
    canCreate,
    /** A temporary account also needs server:osUsers. */
    canCreateUser: canCreate && !!can["server.osUsers"],
    canRevokeAny: !!can["accessGrant.revoke"],
    canSudo: !!can["server.sudo"],
  };
}

/** A clock that ticks every `intervalMs`; drives the countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatDateTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "in 3h 12m" for live grants, "expired 2m ago" otherwise; coloured as the deadline nears. */
export function ExpiryCountdown({ grant, now }: { grant: Pick<AccessGrantDto, "expiresAt" | "status">; now: number }) {
  const left = new Date(grant.expiresAt).getTime() - now;
  const live = grant.status === "active" || grant.status === "expired_pending";
  if (!live) {
    return <span className="text-muted-foreground" title={new Date(grant.expiresAt).toLocaleString()}>{formatDateTime(grant.expiresAt)}</span>;
  }
  if (left <= 0) {
    return (
      <span className="text-amber-400" title={new Date(grant.expiresAt).toLocaleString()}>
        expired {formatRemaining(left)} ago
      </span>
    );
  }
  return (
    <span
      className={cn("tabular-nums", left < 5 * 60_000 ? "text-red-400" : left < 3600_000 ? "text-amber-400" : "text-foreground")}
      title={new Date(grant.expiresAt).toLocaleString()}
    >
      in {formatRemaining(left)}
    </span>
  );
}

export function AccessGrantStatusBadge({ grant, now }: { grant: Pick<AccessGrantDto, "status" | "expiresAt" | "attempts">; now: number }) {
  const cls = "text-[10px] px-1.5 py-0";
  switch (grant.status) {
    case "active":
      if (new Date(grant.expiresAt).getTime() <= now) {
        return (
          <Badge variant="warning" className={cls}>
            {grant.attempts > 0 ? `Revoke retry ${grant.attempts}/${ACCESS_GRANT_MAX_REVOKE_ATTEMPTS}` : "Revoking…"}
          </Badge>
        );
      }
      return (
        <Badge variant="success" className={cls}>
          Active
        </Badge>
      );
    case "expired_pending":
      return (
        <Badge variant="warning" className={cls}>
          Working…
        </Badge>
      );
    case "revoked":
      return (
        <Badge variant="secondary" className={cls}>
          Revoked
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className={cls}>
          Revoke failed
        </Badge>
      );
  }
}

export function describeGrantAccess(grant: Pick<AccessGrantDto, "kind" | "onExpiry">): string {
  if (grant.kind === "ssh_key") return "Temporary key";
  return grant.onExpiry === "delete" ? "Temporary user (deleted on expiry)" : "Temporary user (locked on expiry)";
}

// ─── Expiry picker ───────────────────────────────────────────────────────────

export type ExpiryPreset = (typeof ACCESS_GRANT_DURATION_PRESETS)[number]["id"] | "custom";
export interface ExpiryChoice {
  preset: ExpiryPreset;
  /** datetime-local value, used when preset is "custom". */
  custom: string;
}

export function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function defaultExpiryChoice(preset: ExpiryPreset = "8h"): ExpiryChoice {
  return { preset, custom: toLocalInputValue(new Date(Date.now() + 24 * 3600_000)) };
}

/** The chosen expiry: `base + preset`, or the custom local date-time. */
export function resolveExpiry(choice: ExpiryChoice, base: number): Date | null {
  if (choice.preset === "custom") {
    if (!choice.custom) return null;
    const d = new Date(choice.custom);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const preset = ACCESS_GRANT_DURATION_PRESETS.find((p) => p.id === choice.preset);
  return preset ? new Date(base + preset.ms) : null;
}

export function ExpiryPicker({
  choice,
  onChange,
  base,
  label = "Access expires",
  relativeTo = "now",
}: {
  choice: ExpiryChoice;
  onChange: (c: ExpiryChoice) => void;
  /** Epoch ms the presets are added to. */
  base: number;
  label?: string;
  relativeTo?: string;
}) {
  const resolved = resolveExpiry(choice, base);
  const error = resolved ? accessGrantExpiryError(resolved) : "Pick a date and time";
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {ACCESS_GRANT_DURATION_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange({ ...choice, preset: p.id })}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs transition-colors",
              choice.preset === p.id ? "border-primary bg-primary/20 text-primary" : "border-white/10 bg-white/5 hover:bg-white/10",
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange({ ...choice, preset: "custom" })}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs transition-colors",
            choice.preset === "custom" ? "border-primary bg-primary/20 text-primary" : "border-white/10 bg-white/5 hover:bg-white/10",
          )}
        >
          Custom…
        </button>
      </div>
      {choice.preset === "custom" && (
        <Input
          type="datetime-local"
          value={choice.custom}
          onChange={(e) => onChange({ ...choice, custom: e.target.value })}
          className="h-8 w-60 text-xs"
        />
      )}
      <p className={cn("text-[11px]", error ? "text-red-400" : "text-muted-foreground")}>
        {error ??
          `${choice.preset === "custom" ? "" : `${relativeTo === "now" ? "From now" : relativeTo} → `}${formatDateTime(resolved!)} (your time). Maximum 90 days.`}
      </p>
    </div>
  );
}
