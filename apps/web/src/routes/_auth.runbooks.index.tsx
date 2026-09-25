import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { RunbookDto, RunbookRunDto } from "@inv/shared";
import { BookOpenCheck, Clock, Play, Plus, RefreshCw, ShieldAlert, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchMe, systemKeys } from "@/lib/queries";
import { fetchRunbookRuns, fetchRunbooks, runbookKeys } from "@/lib/runbooks-api";
import { RunDialog } from "@/components/runbooks/run-dialog";
import { RunStatusBadge, timeAgo } from "@/components/runbooks/run-status";

export const Route = createFileRoute("/_auth/runbooks/")({
  component: RunbooksPage,
});

function RunbooksPage() {
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 5 * 60 * 1000 });
  const canCreate = !!me?.can?.["runbook.create"];
  const canExecute = !!me?.can?.["runbook.execute"];
  const canApprove = !!me?.can?.["runbook.approve"];
  const [running, setRunning] = useState<RunbookDto | null>(null);

  const runbooks = useQuery({ queryKey: runbookKeys.list, queryFn: fetchRunbooks });
  const recent = useQuery({
    queryKey: runbookKeys.runs({ limit: 20 }),
    queryFn: () => fetchRunbookRuns({ limit: 20 }),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === "running" || r.status === "queued") ? 3000 : 15_000),
  });
  const pending = useQuery({
    queryKey: runbookKeys.runs({ status: "pending_approval" }),
    queryFn: () => fetchRunbookRuns({ status: "pending_approval", limit: 50 }),
    enabled: canApprove,
    refetchInterval: 15_000,
  });

  const items = runbooks.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Runbooks</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Scripts run across selected servers, with approval for anything risky.</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void runbooks.refetch()} disabled={runbooks.isFetching}>
            <RefreshCw className={`h-4 w-4 ${runbooks.isFetching ? "animate-spin" : ""}`} />
          </Button>
          {canCreate && (
            <Button size="sm" asChild>
              <Link to="/runbooks/$runbookId" params={{ runbookId: "new" }}>
                <Plus className="h-4 w-4" /> New runbook
              </Link>
            </Button>
          )}
        </div>
      </div>

      {canApprove && (pending.data?.items.length ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 shadow-xl">
          <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-semibold">Waiting for approval</span>
            <Badge variant="warning" className="ml-1 text-xs">
              {pending.data!.items.length}
            </Badge>
          </div>
          <div className="divide-y divide-white/5">
            {pending.data!.items.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-card/60 shadow-xl backdrop-blur-md">
        <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
          <BookOpenCheck className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Runbooks</span>
          <Badge variant="outline" className="ml-1 text-xs">
            {items.length}
          </Badge>
        </div>
        {runbooks.isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : runbooks.error ? (
          <div className="px-4 py-8 text-center text-sm text-destructive">{(runbooks.error as Error).message}</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No runbooks yet.{canCreate ? " Create one to run a script across your servers." : ""}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Runs as</th>
                  <th className="px-4 py-2 font-medium">Schedule</th>
                  <th className="px-4 py-2 font-medium">Last run</th>
                  <th className="px-4 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {items.map((rb) => (
                  <tr key={rb.id} className="hover:bg-white/5">
                    <td className="px-4 py-2.5">
                      <Link to="/runbooks/$runbookId" params={{ runbookId: String(rb.id) }} className="font-medium hover:underline">
                        {rb.name}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">v{rb.version}</span>
                      {rb.description && <div className="max-w-md truncate text-xs text-muted-foreground">{rb.description}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={rb.runAs === "root" ? "destructive" : "outline"}>{rb.runAs === "root" ? "root" : "SSH user"}</Badge>
                        {rb.requireApproval && <Badge variant="warning">approval</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {rb.schedule && rb.scheduleEnabled ? (
                        <span className="flex items-center gap-1">
                          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                          <code>{rb.schedule}</code>
                          <span className="text-muted-foreground">{rb.scheduleTimezone}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">manual</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {rb.lastRun ? (
                        <Link to="/runbooks/runs/$runId" params={{ runId: String(rb.lastRun.id) }} className="flex items-center gap-2">
                          <RunStatusBadge status={rb.lastRun.status} />
                          <span className="text-xs text-muted-foreground">
                            {rb.lastRun.dryRun ? "dry run · " : ""}
                            {timeAgo(rb.lastRun.createdAt)}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">never</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {canExecute && (
                        <Button size="sm" variant="outline" onClick={() => setRunning(rb)}>
                          <Play className="h-3.5 w-3.5" /> Run
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-white/10 bg-card/60 shadow-xl backdrop-blur-md">
        <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Recent runs</span>
        </div>
        {(recent.data?.items.length ?? 0) === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">No runs yet.</div>
        ) : (
          <div className="divide-y divide-white/5">
            {recent.data!.items.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </div>
        )}
      </div>

      {running && <RunDialog runbook={running} open={!!running} onOpenChange={(o) => !o && setRunning(null)} />}
    </div>
  );
}

function RunRow({ run }: { run: RunbookRunDto }) {
  const s = run.summary;
  return (
    <Link
      to="/runbooks/runs/$runId"
      params={{ runId: String(run.id) }}
      className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5"
    >
      <span className="w-14 font-mono text-xs text-muted-foreground">#{run.id}</span>
      <span className="font-medium">{run.runbookName}</span>
      <RunStatusBadge status={run.status} />
      {run.dryRun && <Badge variant="outline">dry run</Badge>}
      {run.runAs === "root" && <Badge variant="destructive">root</Badge>}
      <span className="text-xs text-muted-foreground">
        {run.targetServerIds.length} host(s)
        {s ? ` · ${s.succeeded} ok${s.failed + s.timedOut ? ` · ${s.failed + s.timedOut} failed` : ""}` : ""}
      </span>
      <span className="ml-auto text-xs text-muted-foreground">
        {run.triggeredBy === "schedule" ? "scheduled" : run.requestedBy?.name ?? run.triggeredBy} · {timeAgo(run.createdAt)}
      </span>
    </Link>
  );
}
