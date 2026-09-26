import { Fragment, useEffect, useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatPingDto } from "@inv/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Activity, ArrowLeft, ChevronDown, ChevronRight, Copy, KeyRound, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  deleteHeartbeat,
  fetchHeartbeat,
  fetchHeartbeatPings,
  heartbeatKeys,
  pauseHeartbeat,
  resumeHeartbeat,
} from "@/lib/heartbeats-api";
import { HeartbeatFormDialog } from "@/components/heartbeats/heartbeat-form-dialog";
import { RotateTokenDialog } from "@/components/heartbeats/rotate-token-dialog";
import { HeartbeatUsage } from "@/components/heartbeats/heartbeat-usage";
import { PingSparkline } from "@/components/heartbeats/ping-sparkline";
import {
  HeartbeatStatusBadge,
  copyText,
  describeHeartbeatSchedule,
  formatDuration,
  formatSeconds,
  relativeTime,
  useHeartbeatPermissions,
} from "@/components/heartbeats/heartbeat-status";

export const Route = createFileRoute("/_auth/heartbeats/$heartbeatId")({
  component: HeartbeatDetailPage,
});

const KIND_STYLE: Record<HeartbeatPingDto["kind"], string> = {
  success: "text-emerald-400",
  fail: "text-red-400",
  start: "text-sky-400",
  log: "text-slate-400",
};

function Field({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="space-y-0.5" title={title}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-xs">{children}</div>
    </div>
  );
}

function HeartbeatDetailPage() {
  const { heartbeatId } = Route.useParams();
  const id = Number(heartbeatId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const perms = useHeartbeatPermissions();
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [olderPings, setOlderPings] = useState<HeartbeatPingDto[]>([]);
  /** undefined = only the first page (from the detail) is shown; null = no older pings. */
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: heartbeatKeys.detail(id),
    queryFn: () => fetchHeartbeat(id),
    refetchInterval: 15_000,
    enabled: Number.isFinite(id),
  });

  // The first page comes with the detail; "load more" pages by id from its end.
  useEffect(() => {
    setOlderPings([]);
    setCursor(undefined);
  }, [id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: heartbeatKeys.all });

  const toggleMutation = useMutation({
    mutationFn: () => (data?.heartbeat.status === "paused" ? resumeHeartbeat(id) : pauseHeartbeat(id)),
    onSuccess: (r) => {
      toast.success(r.heartbeat.status === "paused" ? "Heartbeat paused" : "Heartbeat resumed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteHeartbeat(id),
    onSuccess: () => {
      toast.success("Heartbeat deleted");
      invalidate();
      navigate({ to: "/heartbeats" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function loadMore() {
    const from = cursor === undefined ? olderPings.at(-1)?.id ?? data?.pings.at(-1)?.id : cursor;
    if (!from) return;
    setLoadingMore(true);
    try {
      const page = await fetchHeartbeatPings(id, from);
      setOlderPings((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 space-y-3">
        <Link to="/heartbeats" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Heartbeats
        </Link>
        <p className="text-sm text-muted-foreground">{(error as Error | null)?.message ?? "Heartbeat not found."}</p>
      </div>
    );
  }

  const hb = data.heartbeat;
  const pings = [...data.pings, ...olderPings.filter((p) => !data.pings.some((q) => q.id === p.id))];
  const hasMore = cursor === undefined ? data.pings.length >= 50 : cursor !== null;
  const urlForSnippets = data.pingUrl ?? (data.token ? `<PUBLIC_BASE_URL>/api/v1/ping/${data.token}` : null);
  const toggle = (pid: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-4 bg-card/40 backdrop-blur-sm">
        <div className="space-y-1">
          <Link to="/heartbeats" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Heartbeats
          </Link>
          <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" /> {hb.name}
            <HeartbeatStatusBadge status={hb.status} />
          </h1>
          <p className="text-sm text-muted-foreground">
            {describeHeartbeatSchedule(hb)}
            {hb.kind === "cron" && <span className="font-mono text-xs"> · {hb.schedule} ({hb.timezone})</span>}
            {hb.server && (
              <>
                {" · "}
                <Link to="/servers/$serverId" params={{ serverId: String(hb.server.id) }} className="hover:underline">
                  {hb.server.hostname}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {perms.canUpdate && (
            <>
              <Button size="sm" variant="outline" onClick={() => toggleMutation.mutate()} disabled={toggleMutation.isPending}>
                {hb.status === "paused" ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                {hb.status === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRotating(true)}>
                <KeyRound className="h-3.5 w-3.5" /> Rotate token
              </Button>
            </>
          )}
          {perms.canDelete && (
            <Button size="sm" variant="outline" className="text-rose-400 hover:text-rose-300" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {hb.description && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{hb.description}</p>}

        <Card>
          <CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <Field label="Last ping" title={hb.lastPingAt ? new Date(hb.lastPingAt).toLocaleString() : undefined}>
              {relativeTime(hb.lastPingAt)} {hb.lastPingKind && <span className="text-muted-foreground">({hb.lastPingKind})</span>}
            </Field>
            <Field label="Next expected" title={hb.expectedAt ? new Date(hb.expectedAt).toLocaleString() : undefined}>
              {hb.status === "paused" ? "paused" : hb.expectedAt ? relativeTime(hb.expectedAt) : "after the first ping"}
            </Field>
            <Field label="Down if silent until" title={hb.alertAt ? new Date(hb.alertAt).toLocaleString() : undefined}>
              {hb.alertAt ? new Date(hb.alertAt).toLocaleString() : "—"}
            </Field>
            <Field label="Last exit code">
              {hb.lastExitCode === null ? "—" : <span className={hb.lastExitCode === 0 ? "text-emerald-400" : "text-red-400"}>{hb.lastExitCode}</span>}
            </Field>
            <Field label="Last duration">{formatDuration(hb.lastDurationMs)}</Field>
            <Field label="Grace">{formatSeconds(hb.graceSeconds)}</Field>
            <Field label="Max runtime">{hb.maxRuntimeSeconds ? formatSeconds(hb.maxRuntimeSeconds) : "= grace"}</Field>
            <Field label="Alerts">
              {hb.notifyOnLate ? "late and down" : "down only"}
              {hb.resumeOnPing ? "" : " · stays paused on ping"}
            </Field>
            <div className="col-span-2 md:col-span-4">
              <PingSparkline pings={data.pings} />
            </div>
          </CardContent>
        </Card>

        {hb.cronSource && (
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm font-semibold">Crontab entry</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 space-y-1 text-xs">
              <div className="text-muted-foreground">
                {hb.cronSource.target.kind === "user"
                  ? `crontab of ${hb.cronSource.target.user}`
                  : hb.cronSource.target.kind === "crond"
                    ? `/etc/cron.d/${hb.cronSource.target.file}`
                    : "/etc/crontab"}
                {hb.server ? ` on ${hb.server.hostname}` : ""} · label "{hb.cronSource.label}"
              </div>
              <pre className="rounded-md bg-black/40 border border-white/10 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                {hb.cronSource.originalCommand}
              </pre>
              <p className="text-[11px] text-muted-foreground">
                RackMap wrapped this command so each run reports its exit code. Turn monitoring off in the server's Cron tab to restore it.
              </p>
            </CardContent>
          </Card>
        )}

        {perms.canUpdate && (
          <Card>
            <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-semibold">How to ping</CardTitle>
              {(data.pingUrl ?? data.token) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={async () => {
                    if (await copyText(data.pingUrl ?? data.token!)) toast.success(data.pingUrl ? "Ping URL copied" : "Token copied");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" /> Copy {data.pingUrl ? "ping URL" : "token"}
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-4 pt-0 space-y-2">
              {!data.pingUrl && (
                <p className="text-[11px] text-amber-300">
                  PUBLIC_BASE_URL is not set; replace &lt;PUBLIC_BASE_URL&gt; with this instance's externally reachable URL.
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                <code className="font-mono">GET</code> or <code className="font-mono">POST</code> the URL on success. Add{" "}
                <code className="font-mono">/start</code> when a run begins, <code className="font-mono">/fail</code> or{" "}
                <code className="font-mono">/&lt;exit code&gt;</code> to report the result, <code className="font-mono">/log</code> for a note.
                A POST body (up to 10 KB) is kept as the run's output.
              </p>
              <HeartbeatUsage url={urlForSnippets} heartbeat={hb} />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">Pings</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {pings.length === 0 ? (
              <p className="px-4 pb-4 text-xs text-muted-foreground">No pings yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/8 bg-white/3 text-muted-foreground">
                    <th className="w-6" />
                    <th className="px-3 py-2 text-left font-semibold">Time</th>
                    <th className="px-3 py-2 text-left font-semibold">Kind</th>
                    <th className="px-3 py-2 text-left font-semibold">Exit</th>
                    <th className="px-3 py-2 text-left font-semibold">Duration</th>
                    <th className="px-3 py-2 text-left font-semibold">From</th>
                  </tr>
                </thead>
                <tbody>
                  {pings.map((p) => {
                    const open = expanded.has(p.id);
                    return (
                      <Fragment key={p.id}>
                        <tr
                          className={`border-b border-white/5 ${p.body ? "cursor-pointer hover:bg-white/4" : ""}`}
                          onClick={() => p.body && toggle(p.id)}
                        >
                          <td className="pl-3 text-muted-foreground">
                            {p.body ? open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" /> : null}
                          </td>
                          <td className="px-3 py-2" title={relativeTime(p.createdAt)}>{new Date(p.createdAt).toLocaleString()}</td>
                          <td className={`px-3 py-2 font-medium ${KIND_STYLE[p.kind]}`}>{p.kind}</td>
                          <td className="px-3 py-2">{p.exitCode ?? "—"}</td>
                          <td className="px-3 py-2">{formatDuration(p.durationMs)}</td>
                          <td className="px-3 py-2 text-muted-foreground truncate max-w-[260px]" title={p.userAgent ?? undefined}>
                            {p.remoteIp ?? "—"}
                            {p.userAgent && <span className="ml-1 text-[10px]">· {p.userAgent}</span>}
                          </td>
                        </tr>
                        {open && p.body && (
                          <tr className="border-b border-white/5 bg-black/20">
                            <td />
                            <td colSpan={5} className="px-3 py-2">
                              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{p.body}</pre>
                              {p.bodyTruncated && (
                                <Badge variant="outline" className="mt-1 text-[10px]">
                                  truncated to 10 KB
                                </Badge>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
            {hasMore && (
              <div className="p-3 text-center">
                <Button size="sm" variant="ghost" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load older pings"}
                </Button>
              </div>
            )}
            {!perms.canUpdate && pings.some((p) => p.bodyTruncated || p.kind === "fail") && (
              <p className="px-4 pb-3 text-[11px] text-muted-foreground">Job output is visible to editors and admins.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <HeartbeatFormDialog open={editing} onOpenChange={setEditing} heartbeat={hb} />
      <RotateTokenDialog heartbeat={hb} open={rotating} onOpenChange={setRotating} />
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete heartbeat "{hb.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Its ping history is deleted and its URL stops working.
              {hb.cronSource &&
                " It is linked to a crontab entry that will keep pinging the dead URL — turn monitoring off in the server's Cron tab instead, which restores the original command."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteMutation.mutate()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
