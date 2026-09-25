import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HEARTBEAT_STATUSES, type HeartbeatDto, type HeartbeatStatus } from "@inv/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { Activity, AlertTriangle, Copy, Pause, Pencil, Play, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  deleteHeartbeat,
  fetchHeartbeat,
  fetchHeartbeats,
  heartbeatKeys,
  pauseHeartbeat,
  resumeHeartbeat,
} from "@/lib/heartbeats-api";
import { HeartbeatFormDialog } from "@/components/heartbeats/heartbeat-form-dialog";
import { PingSparkline } from "@/components/heartbeats/ping-sparkline";
import {
  HeartbeatStatusDot,
  copyText,
  describeHeartbeatSchedule,
  relativeTime,
  useHeartbeatPermissions,
} from "@/components/heartbeats/heartbeat-status";

export const Route = createFileRoute("/_auth/heartbeats/")({
  component: HeartbeatsPage,
});

const STATUS_ORDER: Record<HeartbeatStatus, number> = { down: 0, late: 1, new: 2, up: 3, paused: 4 };

function HeartbeatsPage() {
  const qc = useQueryClient();
  const perms = useHeartbeatPermissions();
  const [status, setStatus] = useState<HeartbeatStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<HeartbeatDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<HeartbeatDto | null>(null);

  const params = status === "all" ? {} : { status };
  const { data, isLoading } = useQuery({
    queryKey: heartbeatKeys.list(params),
    queryFn: () => fetchHeartbeats(params),
    refetchInterval: 30_000,
  });

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((h) => !q || h.name.toLowerCase().includes(q) || h.server?.hostname.toLowerCase().includes(q))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
  }, [data?.items, search]);

  const counts = useMemo(() => {
    const c: Partial<Record<HeartbeatStatus, number>> = {};
    for (const h of data?.items ?? []) c[h.status] = (c[h.status] ?? 0) + 1;
    return c;
  }, [data?.items]);

  const invalidate = () => qc.invalidateQueries({ queryKey: heartbeatKeys.all });

  const toggleMutation = useMutation({
    mutationFn: (hb: HeartbeatDto) => (hb.status === "paused" ? resumeHeartbeat(hb.id) : pauseHeartbeat(hb.id)),
    onSuccess: (r) => {
      toast.success(r.heartbeat.status === "paused" ? "Heartbeat paused" : "Heartbeat resumed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteHeartbeat(id),
    onSuccess: () => {
      toast.success("Heartbeat deleted");
      setDeleting(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function copyUrl(hb: HeartbeatDto) {
    try {
      const d = await fetchHeartbeat(hb.id);
      const value = d.pingUrl ?? d.token;
      if (!value) {
        toast.error("You cannot view this heartbeat's ping URL");
        return;
      }
      if (await copyText(value)) toast.success(d.pingUrl ? "Ping URL copied" : "Token copied (PUBLIC_BASE_URL is not set)");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-4 bg-card/40 backdrop-blur-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" /> Heartbeats
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Dead-man's switches for cron jobs, backups and anything else that should run on schedule.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search name or server…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 pr-2 text-xs bg-zinc-900/60 border-zinc-700"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as HeartbeatStatus | "all")}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {HEARTBEAT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {perms.canCreate && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4 mr-1" /> New heartbeat
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {data && !data.meta.pingUrlsAvailable && (
          <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
            <span>
              <strong>PUBLIC_BASE_URL is not set.</strong> RackMap cannot show ping URLs or monitor cron jobs until it knows its externally reachable address (for example <code className="font-mono">https://rackmap.example.com</code>).
            </span>
          </div>
        )}

        {(counts.down ?? 0) + (counts.late ?? 0) > 0 && (
          <div className="flex gap-2 text-xs">
            {counts.down ? <span className="rounded-md bg-red-500/15 px-2 py-1 text-red-400">{counts.down} down</span> : null}
            {counts.late ? <span className="rounded-md bg-amber-500/15 px-2 py-1 text-amber-400">{counts.late} late</span> : null}
          </div>
        )}

        <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/3">
                {["", "Name", "Server", "Schedule", "Last ping", "Next expected", "Last 30 pings"].map((h, i) => (
                  <th key={i} className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {h}
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-white/5">
                    {Array.from({ length: 8 }).map((__, j) => (
                      <td key={j} className="px-3 py-3">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-muted-foreground text-sm">
                    {data?.items.length
                      ? "No heartbeats match."
                      : "No heartbeats yet. Create one, or turn on \"Monitor this job\" for an entry in a server's Cron tab."}
                  </td>
                </tr>
              )}
              {items.map((hb) => (
                <tr key={hb.id} className="border-b border-white/5 last:border-0 hover:bg-white/4">
                  <td className="px-3 py-3 w-6">
                    <HeartbeatStatusDot status={hb.status} />
                  </td>
                  <td className="px-3 py-3">
                    <Link to="/heartbeats/$heartbeatId" params={{ heartbeatId: String(hb.id) }} className="font-medium hover:underline">
                      {hb.name}
                    </Link>
                    {hb.cronSource && <div className="text-[10px] text-muted-foreground">from crontab</div>}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {hb.server ? (
                      <Link to="/servers/$serverId" params={{ serverId: String(hb.server.id) }} className="hover:underline">
                        {hb.server.hostname}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs max-w-[220px]">
                    <div className="truncate" title={hb.schedule ?? undefined}>{describeHeartbeatSchedule(hb)}</div>
                    {hb.kind === "cron" && <div className="text-[10px] text-muted-foreground font-mono">{hb.schedule} · {hb.timezone}</div>}
                  </td>
                  <td className="px-3 py-3 text-xs" title={hb.lastPingAt ? new Date(hb.lastPingAt).toLocaleString() : undefined}>
                    {relativeTime(hb.lastPingAt)}
                    {hb.lastExitCode !== null && hb.lastExitCode !== 0 && (
                      <span className="ml-1 text-red-400">(exit {hb.lastExitCode})</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs" title={hb.expectedAt ? new Date(hb.expectedAt).toLocaleString() : undefined}>
                    {hb.status === "paused" ? "—" : hb.expectedAt ? relativeTime(hb.expectedAt) : <span className="text-muted-foreground">after first ping</span>}
                  </td>
                  <td className="px-3 py-3">
                    <PingSparkline pings={hb.recentPings ?? []} />
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {perms.canUpdate && (
                        <>
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="Copy ping URL" onClick={() => copyUrl(hb)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title={hb.status === "paused" ? "Resume" : "Pause"}
                            disabled={toggleMutation.isPending}
                            onClick={() => toggleMutation.mutate(hb)}
                          >
                            {hb.status === "paused" ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit" onClick={() => setEditing(hb)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      {perms.canDelete && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-rose-400 hover:bg-rose-500/20"
                          title="Delete"
                          onClick={() => setDeleting(hb)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <HeartbeatFormDialog open={creating} onOpenChange={setCreating} />
      <HeartbeatFormDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} heartbeat={editing} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete heartbeat "{deleting?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Its ping history is deleted and its URL stops working.
              {deleting?.cronSource &&
                " It is linked to a crontab entry that will keep pinging the dead URL — turn monitoring off in the server's Cron tab instead, which restores the original command."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && deleteMutation.mutate(deleting.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
