import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { isProtectedSystemdUnit, SYSTEMD_LOG_LINES_MAX, type SystemdAction } from "@inv/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertCircle, Copy, Loader2, Lock, RefreshCw, ScrollText, ShieldAlert, Zap } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchSystemdLogs, fetchSystemdUnit, systemdKeys } from "@/lib/systemd-api";
import { ACTION_LABELS, ACTION_ORDER, ActiveBadge, EnabledBadge, actionBlockedReason, formatBytes } from "./systemd-shared";

/** 20 comes with the unit details (no extra SSH round trip); the rest query the journal. */
const LINE_OPTIONS = [20, 100, 200, 500, 1000, SYSTEMD_LOG_LINES_MAX];
const SINCE_OPTIONS: { value: string; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "15m", label: "Last 15 min" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
];

interface UnitDetailDialogProps {
  serverId: number;
  unit: string | null;
  onOpenChange: (open: boolean) => void;
  canSudo: boolean;
  licensed: boolean;
  onRequestAction: (unit: string, action: SystemdAction) => void;
}

export function UnitDetailDialog({ serverId, unit, onOpenChange, canSudo, licensed, onRequestAction }: UnitDetailDialogProps) {
  const open = unit !== null;
  const [lines, setLines] = useState(20);
  const [since, setSince] = useState("any");
  const [wrap, setWrap] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  // Each unit opens on the summary view.
  useEffect(() => {
    if (open) {
      setLines(20);
      setSince("any");
    }
  }, [open, unit]);

  const detailQuery = useQuery({
    queryKey: systemdKeys.unit(serverId, unit ?? ""),
    queryFn: () => fetchSystemdUnit(serverId, unit!),
    enabled: open,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const fromDetails = lines === 20 && since === "any";
  const sinceParam = since === "any" ? "" : since;
  const logsQuery = useQuery({
    queryKey: systemdKeys.logs(serverId, unit ?? "", lines, sinceParam),
    queryFn: () => fetchSystemdLogs(serverId, unit!, { lines, since: sinceParam || undefined }),
    enabled: open && !fromDetails,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const details = detailQuery.data;
  const journal = fromDetails ? details?.journal : logsQuery.data?.lines;
  const journalLoading = fromDetails ? detailQuery.isLoading : logsQuery.isLoading;
  const journalFetching = fromDetails ? detailQuery.isFetching : logsQuery.isFetching;
  const journalError = fromDetails ? null : logsQuery.error;
  const ranAsRoot = fromDetails ? details?.ranAsRoot : logsQuery.data?.ranAsRoot;

  // Newest entries are at the bottom; keep them in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [journal]);

  function refresh() {
    if (fromDetails) void detailQuery.refetch();
    else {
      void logsQuery.refetch();
      void detailQuery.refetch();
    }
  }

  const protectedUnit = unit ? isProtectedSystemdUnit(unit) : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-6">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500 shrink-0">
                <ScrollText className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-base font-mono truncate flex items-center gap-1.5">
                  {unit}
                  {protectedUnit && <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0" aria-label="protected unit" />}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5 truncate">
                  {details?.description || (detailQuery.isLoading ? "Reading the unit over SSH…" : "systemd unit")}
                </DialogDescription>
              </div>
            </div>
            {unit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 shrink-0">
                    <Zap className="h-3.5 w-3.5" /> Actions
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {ACTION_ORDER.map((a) => {
                    const blocked = actionBlockedReason(unit, a, { canSudo, licensed });
                    return (
                      <DropdownMenuItem
                        key={a}
                        disabled={blocked !== null}
                        onClick={() => onRequestAction(unit, a)}
                        className="text-xs gap-2"
                        title={blocked ?? undefined}
                      >
                        {ACTION_LABELS[a]}
                        {blocked && <Lock className="h-3 w-3 ml-auto text-muted-foreground" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </DialogHeader>

        {detailQuery.isError ? (
          <div className="flex items-start gap-1.5 text-xs text-destructive rounded-md border border-destructive/30 bg-destructive/10 p-2">
            <AlertCircle className="h-4 w-4 mt-px shrink-0" />
            <span>{(detailQuery.error as { message?: string })?.message || "Failed to read the unit"}</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Prop label="State">
              {details ? <ActiveBadge active={details.activeState} sub={details.subState} /> : <Dash loading={detailQuery.isLoading} />}
            </Prop>
            <Prop label="Unit file">
              {details ? <EnabledBadge state={details.unitFileState} /> : <Dash loading={detailQuery.isLoading} />}
            </Prop>
            <Prop label="Load">{details ? <span className="font-mono">{details.loadState}</span> : <Dash loading={detailQuery.isLoading} />}</Prop>
            <Prop label="Main PID">{details ? <span className="font-mono">{details.mainPid ?? "—"}</span> : <Dash loading={detailQuery.isLoading} />}</Prop>
            <Prop label="Started">{details ? <span className="font-mono">{details.startedAt ?? "—"}</span> : <Dash loading={detailQuery.isLoading} />}</Prop>
            <Prop label="Memory">{details ? <span className="font-mono">{formatBytes(details.memoryBytes)}</span> : <Dash loading={detailQuery.isLoading} />}</Prop>
            <Prop label="Restart policy">{details ? <span className="font-mono">{details.restart ?? "—"}</span> : <Dash loading={detailQuery.isLoading} />}</Prop>
            <Prop label="Restarts">{details ? <span className="font-mono">{details.nRestarts ?? "—"}</span> : <Dash loading={detailQuery.isLoading} />}</Prop>
            <Prop label="Unit file path" className="col-span-2 md:col-span-4">
              {details ? <span className="font-mono break-all">{details.fragmentPath ?? "—"}</span> : <Dash loading={detailQuery.isLoading} />}
            </Prop>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs font-semibold flex items-center gap-1.5">
              Journal
              {ranAsRoot === false && (
                <Badge variant="warning" className="text-[9px] py-0 px-1.5" title="sudo was unavailable, so journalctl ran as the SSH user">
                  read without root — may be incomplete
                </Badge>
              )}
              {!fromDetails && logsQuery.data?.truncated && (
                <Badge variant="warning" className="text-[9px] py-0 px-1.5">
                  truncated
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Select value={String(lines)} onValueChange={(v) => setLines(Number(v))}>
                <SelectTrigger className="h-7 w-[120px] text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINE_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)} className="text-xs">
                      Last {n} lines
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={since} onValueChange={setSince}>
                <SelectTrigger className="h-7 w-[130px] text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SINCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="ghost" className="h-7 text-[11px] px-2" onClick={() => setWrap((w) => !w)}>
                {wrap ? "No wrap" : "Wrap"}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label="Copy journal"
                disabled={!journal?.length}
                onClick={() => {
                  navigator.clipboard?.writeText((journal ?? []).join("\n")).then(
                    () => toast.success("Journal copied to the clipboard"),
                    () => toast.error("Could not copy to the clipboard"),
                  );
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1" onClick={refresh} disabled={journalFetching}>
                <RefreshCw className={cn("h-3 w-3", journalFetching && "animate-spin")} /> Refresh
              </Button>
            </div>
          </div>
          <pre
            ref={logRef}
            className={cn(
              "h-[380px] overflow-auto rounded-md border bg-black/40 p-2 text-[11px] font-mono leading-5",
              wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
            )}
          >
            {journalLoading ? (
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the journal over SSH…
              </span>
            ) : journalError ? (
              <span className="text-destructive">{(journalError as { message?: string })?.message || "Failed to read the journal"}</span>
            ) : journal && journal.length > 0 ? (
              journal.map((l, i) => (
                <div key={i} className={cn(/\b(error|failed|fatal|panic)\b/i.test(l) && "text-rose-300")}>
                  {l}
                </div>
              ))
            ) : (
              <span className="text-muted-foreground">(no journal entries)</span>
            )}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Prop({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-md border bg-muted/30 p-2 text-[11px] min-w-0", className)}>
      <div className="text-[10px] uppercase text-muted-foreground mb-0.5">{label}</div>
      <div className="truncate">{children}</div>
    </div>
  );
}

function Dash({ loading }: { loading: boolean }) {
  return loading ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> : <span className="text-muted-foreground">—</span>;
}
