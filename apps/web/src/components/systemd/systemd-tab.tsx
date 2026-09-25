import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isProtectedSystemdUnit,
  isValidSystemdUnitName,
  systemdActionNeedsSudo,
  type SystemdAction,
  type SystemdActionResponse,
  type SystemdListType,
  type SystemdUnitListResponse,
} from "@inv/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertCircle,
  Eye,
  Loader2,
  Lock,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  ShieldAlert,
  Square,
  ToggleLeft,
  ToggleRight,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchLicenseStatus, fetchMe, licenseKeys, systemKeys } from "@/lib/queries";
import { fetchSystemdUnits, runSystemdAction, systemdKeys } from "@/lib/systemd-api";
import {
  ACTION_EFFECTS,
  ACTION_LABELS,
  ActiveBadge,
  CenteredNote,
  EnabledBadge,
  actionBlockedReason,
} from "./systemd-shared";
import { UnitDetailDialog } from "./unit-detail-dialog";

type StateFilter = "all" | "active" | "failed" | "inactive";

const TYPE_OPTIONS: { value: SystemdListType; label: string }[] = [
  { value: "service", label: "Services" },
  { value: "timer", label: "Timers" },
  { value: "socket", label: "Sockets" },
  { value: "all", label: "All types" },
];

/** Rendering thousands of rows at once is slow; the filter narrows it down. */
const MAX_ROWS = 500;

const ACTION_ICONS: Record<SystemdAction, typeof Play> = {
  start: Play,
  stop: Square,
  restart: RotateCw,
  reload: RefreshCw,
  enable: ToggleRight,
  disable: ToggleLeft,
};

interface PendingAction {
  unit: string;
  action: SystemdAction;
}

export function SystemdTab({ serverId }: { serverId: number }) {
  const queryClient = useQueryClient();
  const { data: me, isLoading: meLoading } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe });
  const canSystemd = me?.can?.["server.systemd"] === true;
  const canSudo = me?.can?.["server.sudo"] === true;
  const { data: license } = useQuery({
    queryKey: licenseKeys.status(),
    queryFn: fetchLicenseStatus,
    staleTime: 60_000,
    enabled: canSystemd,
  });
  // Until the license is known, let the API decide (it answers NOT_LICENSED).
  const licensed = license ? license.features?.["service_manager"] === true : true;

  const [type, setType] = useState<SystemdListType>("service");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [detailUnit, setDetailUnit] = useState<string | null>(null);

  const unitsQuery = useQuery({
    queryKey: systemdKeys.units(serverId, type),
    queryFn: () => fetchSystemdUnits(serverId, { type }),
    enabled: canSystemd,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const data = unitsQuery.data;

  const counts = useMemo(() => {
    const units = data?.units ?? [];
    return {
      all: units.length,
      active: units.filter((u) => u.active === "active").length,
      failed: units.filter((u) => u.active === "failed").length,
      inactive: units.filter((u) => u.active === "inactive").length,
    };
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.units ?? []).filter((u) => {
      if (stateFilter !== "all" && u.active !== stateFilter) return false;
      if (!q) return true;
      return u.unit.toLowerCase().includes(q) || u.description.toLowerCase().includes(q);
    });
  }, [data, search, stateFilter]);

  const actionMutation = useMutation({
    mutationFn: (v: PendingAction) => runSystemdAction(serverId, v.unit, v.action),
    onSuccess: (res: SystemdActionResponse) => {
      if (res.ok) {
        toast.success(`${ACTION_LABELS[res.action]} ${res.unit}: done`, {
          description: res.activeState ? `Now ${res.activeState}${res.subState ? ` (${res.subState})` : ""}${res.unitFileState ? `, ${res.unitFileState}` : ""}` : undefined,
        });
      } else {
        toast.error(`systemctl ${res.action} ${res.unit} failed${res.exitCode !== null ? ` (exit ${res.exitCode})` : ""}`, {
          description: res.stderr ? res.stderr.slice(0, 400) : undefined,
          duration: 10_000,
        });
      }
      // Patch the row in every cached list (service/timer/all…) rather than re-listing the host.
      queryClient.setQueriesData<SystemdUnitListResponse>({ queryKey: [...systemdKeys.all(serverId), "units"] }, (old) => {
        if (!old) return old;
        return {
          ...old,
          units: old.units.map((u) =>
            u.unit === res.unit
              ? {
                  ...u,
                  active: res.activeState ?? u.active,
                  sub: res.subState ?? u.sub,
                  enabled: res.unitFileState ?? u.enabled,
                }
              : u,
          ),
        };
      });
      void queryClient.invalidateQueries({ queryKey: systemdKeys.unit(serverId, res.unit) });
      void queryClient.invalidateQueries({ queryKey: [...systemdKeys.all(serverId), "logs", res.unit] });
    },
    onError: (err: { message?: string; code?: string }) => {
      toast.error(err?.message || "The action failed");
    },
  });

  if (meLoading) {
    return <CenteredNote icon={<Loader2 className="h-5 w-5 animate-spin" />} text="Loading permissions…" />;
  }
  if (!canSystemd) {
    return (
      <CenteredNote
        icon={<Lock className="h-5 w-5" />}
        text="Viewing and managing systemd services requires the server:systemd permission (editors and admins)."
      />
    );
  }

  const pendingProtected = pending ? isProtectedSystemdUnit(pending.unit) : false;
  const pendingNeedsSudo = pending ? systemdActionNeedsSudo(pending.unit, pending.action) : false;
  const rows = filtered.slice(0, MAX_ROWS);

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="p-4 rounded-xl border bg-card/70 backdrop-blur space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500">
              <Workflow className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">systemd Services</h3>
              <p className="text-xs text-muted-foreground">
                Units on this host with their state and boot enablement. Start, stop, restart, reload, enable or disable a
                unit and read its journal. Every action is recorded in the audit log.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!licensed && (
              <Badge variant="warning" className="text-[10px] gap-1">
                <Lock className="h-3 w-3" /> Actions need Pro
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5"
              onClick={() => unitsQuery.refetch()}
              disabled={unitsQuery.isFetching}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", unitsQuery.isFetching && "animate-spin")} /> Reload from host
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Select value={type} onValueChange={(v) => setType(v as SystemdListType)}>
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name or description…"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <div className="flex rounded-md border p-0.5">
            {(["all", "active", "failed", "inactive"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={stateFilter === s ? "secondary" : "ghost"}
                className={cn("h-7 text-[11px] px-2 gap-1 capitalize", s === "failed" && counts.failed > 0 && "text-destructive")}
                onClick={() => setStateFilter(s)}
              >
                {s}
                {data?.supported && <span className="font-mono text-[10px] opacity-70">{counts[s]}</span>}
              </Button>
            ))}
          </div>
        </div>
        {data?.ranAsRoot === false && (
          <div className="flex items-start gap-1.5 text-[11px] text-amber-500">
            <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
            <span>sudo is unavailable for this server, so units were read as the SSH user; actions will fail until sudo works.</span>
          </div>
        )}
        {data?.truncated && (
          <div className="flex items-start gap-1.5 text-[11px] text-amber-500">
            <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
            <span>The host has more units than RackMap lists; narrow the type filter.</span>
          </div>
        )}
      </div>

      {unitsQuery.isLoading ? (
        <CenteredNote icon={<Loader2 className="h-5 w-5 animate-spin" />} text="Reading systemd units over SSH…" />
      ) : unitsQuery.isError ? (
        <div className="py-10 text-center text-destructive text-xs space-y-2 rounded-xl border">
          <AlertCircle className="h-5 w-5 mx-auto" />
          <div>{(unitsQuery.error as { message?: string })?.message || "Failed to read systemd units"}</div>
          {(unitsQuery.error as { code?: string })?.code === "VAULT_LOCKED" && (
            <div className="text-muted-foreground">Unlock the credential vault, then reload.</div>
          )}
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => unitsQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : data && !data.supported ? (
        <CenteredNote
          icon={<Server className="h-5 w-5" />}
          text="systemd is not running on this host (no systemctl or /run/systemd/system), so there are no units to manage."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            {filtered.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-xs">
                {(data?.units.length ?? 0) === 0 ? "No units of this type on the host." : "No units match the filter."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40 text-muted-foreground text-[10px]">
                      <th className="py-2.5 px-3 text-left font-medium">Unit</th>
                      <th className="py-2.5 px-3 text-left font-medium">State</th>
                      <th className="py-2.5 px-3 text-left font-medium">Boot</th>
                      <th className="py-2.5 px-3 text-left font-medium">Description</th>
                      <th className="py-2.5 px-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {rows.map((u) => {
                      const prot = isProtectedSystemdUnit(u.unit);
                      const valid = isValidSystemdUnitName(u.unit);
                      return (
                        <tr key={u.unit} className={cn("hover:bg-muted/30", u.load === "not-loaded" && "opacity-75")}>
                          <td className="py-2 px-3">
                            <button
                              type="button"
                              className="flex items-center gap-1.5 font-mono text-[11px] text-left hover:underline disabled:no-underline disabled:cursor-default"
                              onClick={() => setDetailUnit(u.unit)}
                              disabled={!valid}
                              title={valid ? "Show details and journal" : "RackMap cannot act on units with this name"}
                            >
                              <span className="truncate max-w-[320px]">{u.unit}</span>
                              {prot && <ShieldAlert className="h-3 w-3 text-amber-500 shrink-0" aria-label="protected unit" />}
                            </button>
                            {u.load !== "loaded" && u.load !== "not-loaded" && (
                              <div className="text-[10px] text-amber-500 font-mono">load: {u.load}</div>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <ActiveBadge active={u.active} sub={u.sub} />
                          </td>
                          <td className="py-2 px-3">
                            <EnabledBadge state={u.enabled} />
                          </td>
                          <td className="py-2 px-3">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block max-w-[380px] truncate text-muted-foreground">{u.description || "—"}</span>
                              </TooltipTrigger>
                              {u.description && <TooltipContent className="max-w-[500px] text-[11px]">{u.description}</TooltipContent>}
                            </Tooltip>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <UnitActionsMenu
                              unit={u.unit}
                              active={u.active}
                              canSudo={canSudo}
                              licensed={licensed}
                              busy={actionMutation.isPending && actionMutation.variables?.unit === u.unit}
                              onDetails={() => setDetailUnit(u.unit)}
                              onAction={(action) => setPending({ unit: u.unit, action })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filtered.length > MAX_ROWS && (
                  <div className="py-2 text-center text-[11px] text-muted-foreground border-t">
                    Showing {MAX_ROWS} of {filtered.length} units — refine the filter to see the rest.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <UnitDetailDialog
        serverId={serverId}
        unit={detailUnit}
        onOpenChange={(o) => !o && setDetailUnit(null)}
        canSudo={canSudo}
        licensed={licensed}
        onRequestAction={(unit, action) => setPending({ unit, action })}
      />

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending ? `${ACTION_LABELS[pending.action]} ${pending.unit}?` : "Confirm"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending ? `This ${ACTION_EFFECTS[pending.action]}` : null} It runs as root on the host and is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending && pendingProtected && (
            <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-400">
              <ShieldAlert className="h-3.5 w-3.5 mt-px shrink-0" />
              <span>
                <span className="font-mono">{pending.unit}</span> is a protected unit (SSH, networking, D-Bus, the container
                runtime, a target or mount, or part of systemd itself).
                {pendingNeedsSudo
                  ? " This action can cut the host off from SSH or its workloads; if the connection drops, RackMap cannot undo it."
                  : ""}
              </span>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) actionMutation.mutate(pending);
                setPending(null);
              }}
              className={cn(
                pending && (pendingNeedsSudo || pending.action === "stop" || pending.action === "disable") &&
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
            >
              {pending ? ACTION_LABELS[pending.action] : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function UnitActionsMenu({
  unit,
  active,
  canSudo,
  licensed,
  busy,
  onDetails,
  onAction,
}: {
  unit: string;
  active: string;
  canSudo: boolean;
  licensed: boolean;
  busy: boolean;
  onDetails: () => void;
  onAction: (action: SystemdAction) => void;
}) {
  const valid = isValidSystemdUnitName(unit);
  const running = active === "active" || active === "activating" || active === "reloading";
  const item = (action: SystemdAction) => {
    const blocked = actionBlockedReason(unit, action, { canSudo, licensed });
    const Icon = ACTION_ICONS[action];
    return (
      <DropdownMenuItem
        key={action}
        onClick={() => onAction(action)}
        disabled={blocked !== null}
        className={cn("text-xs gap-2", (action === "stop" || action === "disable") && "text-destructive focus:text-destructive")}
        title={blocked ?? undefined}
      >
        <Icon className="h-3.5 w-3.5" /> {ACTION_LABELS[action]}
        {blocked && <Lock className="h-3 w-3 ml-auto text-muted-foreground" />}
      </DropdownMenuItem>
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Actions for ${unit}`} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={onDetails} disabled={!valid} className="text-xs gap-2">
          <Eye className="h-3.5 w-3.5" /> Details & journal
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {running ? item("restart") : item("start")}
        {running ? item("reload") : null}
        {running ? item("stop") : null}
        {!running && item("restart")}
        <DropdownMenuSeparator />
        {item("enable")}
        {item("disable")}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
