import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DRIFT_SEVERITIES, type DriftEventDto, type DriftSeverity } from "@inv/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GitCompareArrows, Loader2, Server } from "lucide-react";
import { toast } from "sonner";
import { acknowledgeDriftEvent, driftKeys, fetchDriftEvents, fetchDriftSummary } from "@/lib/drift-api";
import { DriftEventRow, DriftSeverityBadge, relativeTime, useDriftPermissions } from "@/components/drift/drift-ui";

export const Route = createFileRoute("/_auth/drift")({
  component: DriftPage,
});

const PAGE_SIZE = 100;

function DriftPage() {
  const qc = useQueryClient();
  const perms = useDriftPermissions();
  const [status, setStatus] = useState<"open" | "all">("open");
  const [severity, setSeverity] = useState<DriftSeverity | "all">("all");

  const summary = useQuery({ queryKey: driftKeys.summary, queryFn: fetchDriftSummary, refetchInterval: 60_000 });

  const params = { status, ...(severity === "all" ? {} : { severity }), limit: PAGE_SIZE };
  const events = useInfiniteQuery({
    queryKey: driftKeys.events(params),
    queryFn: ({ pageParam }) => fetchDriftEvents({ ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 60_000,
  });

  const groups = useMemo(() => {
    const byServer = new Map<number, { serverId: number; hostname: string; items: DriftEventDto[] }>();
    for (const ev of events.data?.pages.flatMap((p) => p.items) ?? []) {
      let g = byServer.get(ev.serverId);
      if (!g) {
        g = { serverId: ev.serverId, hostname: ev.server?.hostname ?? `#${ev.serverId}`, items: [] };
        byServer.set(ev.serverId, g);
      }
      g.items.push(ev);
    }
    return [...byServer.values()];
  }, [events.data]);

  const ack = useMutation({
    mutationFn: (ev: DriftEventDto) => acknowledgeDriftEvent(ev.id),
    onSuccess: () => {
      toast.success("Event acknowledged");
      qc.invalidateQueries({ queryKey: driftKeys.all });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const open = summary.data?.open;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-4 bg-card/40 backdrop-blur-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <GitCompareArrows className="h-5 w-5 text-primary" /> Configuration drift
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Changes to accounts, sudoers, crontabs, listening ports, enabled units and SSH keys since each server's baseline.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={status} onValueChange={(v) => setStatus(v as "open" | "all")}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open events</SelectItem>
              <SelectItem value="all">All events</SelectItem>
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={(v) => setSeverity(v as DriftSeverity | "all")}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              {[...DRIFT_SEVERITIES].reverse().map((s) => (
                <SelectItem key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {open && open.total > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {open.critical > 0 && <span className="rounded-md bg-red-500/15 px-2 py-1 text-red-400">{open.critical} critical</span>}
            {open.warning > 0 && <span className="rounded-md bg-amber-500/15 px-2 py-1 text-amber-400">{open.warning} warning</span>}
            {open.info > 0 && <span className="rounded-md bg-white/5 px-2 py-1 text-muted-foreground">{open.info} info</span>}
            <span className="text-muted-foreground">
              open on {summary.data?.servers.length ?? 0} server{summary.data?.servers.length === 1 ? "" : "s"}
            </span>
          </div>
        )}

        {events.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : events.error ? (
          <p className="text-sm text-red-400">{(events.error as Error).message}</p>
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-card/60 px-6 py-12 text-center text-sm text-muted-foreground">
            {status === "open"
              ? "No open drift. Servers are scanned nightly; open a server and press \"Scan now\" to check one immediately."
              : "No drift events recorded yet."}
          </div>
        ) : (
          groups.map((g) => {
            const serverSummary = summary.data?.servers.find((s) => s.serverId === g.serverId);
            return (
              <section key={g.serverId} className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 px-4 py-2.5">
                  <Link
                    to="/servers/$serverId"
                    params={{ serverId: String(g.serverId) }}
                    className="flex items-center gap-2 text-sm font-semibold hover:underline"
                  >
                    <Server className="h-4 w-4 text-muted-foreground" />
                    {g.hostname}
                  </Link>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    {serverSummary && (
                      <>
                        <DriftSeverityBadge severity={serverSummary.maxSeverity} />
                        <span>
                          {serverSummary.open} open · last {relativeTime(serverSummary.lastDetectedAt)}
                        </span>
                      </>
                    )}
                  </div>
                </header>
                <ul className="divide-y divide-white/5 px-4">
                  {g.items.map((ev) => (
                    <DriftEventRow
                      key={ev.id}
                      event={ev}
                      canAcknowledge={perms.canAcknowledge}
                      onAcknowledge={(e) => ack.mutate(e)}
                      acknowledging={ack.isPending && ack.variables?.id === ev.id}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}

        {events.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" disabled={events.isFetchingNextPage} onClick={() => events.fetchNextPage()}>
              {events.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
