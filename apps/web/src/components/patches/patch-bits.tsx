import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import type { ServerPatchStatusDto } from "@inv/shared";
import { Badge } from "@/components/ui/badge";
import { fetchMe, systemKeys } from "@/lib/queries";

/** Summary fields shared by the fleet row and the full per-server status. */
export type PatchStatusLike = Omit<ServerPatchStatusDto, "packages">;

export function usePatchPermissions() {
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 60_000 });
  const can = (me?.can ?? {}) as Record<string, boolean>;
  const canPatch = !!can["server.patch"];
  return { canPatch, canApply: canPatch && !!can["server.sudo"] };
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

export function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export const PM_LABELS: Record<string, string> = {
  apt: "apt",
  dnf: "dnf",
  yum: "yum",
  zypper: "zypper",
  unknown: "unknown",
};

/** One badge for "where does this server stand". */
export function PatchStateBadge({ patch }: { patch: PatchStatusLike | null }) {
  if (!patch) return <Badge variant="outline" className="text-[10px] text-muted-foreground">Never scanned</Badge>;
  if (patch.status === "error") return <Badge variant="destructive" className="text-[10px]">Scan failed</Badge>;
  if (patch.status === "unsupported") return <Badge variant="secondary" className="text-[10px]">Unsupported</Badge>;
  if (patch.securityCount > 0) return <Badge variant="destructive" className="text-[10px]">Security updates</Badge>;
  if (patch.upgradableCount > 0) return <Badge variant="warning" className="text-[10px]">Updates pending</Badge>;
  return <Badge variant="success" className="text-[10px]">Up to date</Badge>;
}

export function RebootBadge({ patch }: { patch: PatchStatusLike | null }) {
  if (!patch?.rebootRequired) return null;
  return (
    <Badge variant="warning" className="text-[10px]" title={kernelTitle(patch)}>
      Reboot required
    </Badge>
  );
}

export function kernelTitle(patch: PatchStatusLike): string | undefined {
  if (!patch.kernelRunning) return undefined;
  return patch.kernelUpdatePending && patch.kernelLatest
    ? `Running ${patch.kernelRunning}; newest installed ${patch.kernelLatest}`
    : `Running ${patch.kernelRunning}`;
}
