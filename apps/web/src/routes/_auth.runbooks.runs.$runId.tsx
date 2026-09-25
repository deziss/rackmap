import { Fragment, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isRunbookRunActive, type RunbookRunDetailDto } from "@inv/shared";
import { toast } from "sonner";
import { ArrowLeft, Ban, Check, ChevronDown, ChevronRight, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authClient } from "@/lib/auth-client";
import { fetchMe, systemKeys } from "@/lib/queries";
import {
  approveRunbookRun,
  cancelRunbookRun,
  fetchRunbookRun,
  rejectRunbookRun,
  rerunRunbookRun,
  runbookKeys,
} from "@/lib/runbooks-api";
import { HOST_ERROR_HINTS, HostStatusBadge, RunStatusBadge, formatDuration, timeAgo } from "@/components/runbooks/run-status";
import { HostOutput } from "@/components/runbooks/host-output";
import { ScriptDiff } from "@/components/runbooks/script-diff";

export const Route = createFileRoute("/_auth/runbooks/runs/$runId")({
  component: RunDetailPage,
});

function RunDetailPage() {
  const { runId } = Route.useParams();
  const id = Number(runId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 5 * 60 * 1000 });
  const canApprove = !!me?.can?.["runbook.approve"];
  const canExecute = !!me?.can?.["runbook.execute"];

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [showScript, setShowScript] = useState(false);

  const run = useQuery({
    queryKey: runbookKeys.run(id),
    queryFn: () => fetchRunbookRun(id),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (!s) return false;
      return s === "running" || s === "queued" ? 1500 : s === "pending_approval" ? 10_000 : false;
    },
  });

  const onDone = (msg: string) => (r: { id: number }) => {
    qc.invalidateQueries({ queryKey: ["runbook-runs"] });
    qc.invalidateQueries({ queryKey: runbookKeys.all });
    toast.success(msg);
    if (r.id !== id) void navigate({ to: "/runbooks/runs/$runId", params: { runId: String(r.id) } });
  };
  const onError = (e: Error) => toast.error(e.message);

  const approve = useMutation({ mutationFn: () => approveRunbookRun(id), onSuccess: onDone("Approved — the run is queued"), onError });
  const reject = useMutation({
    mutationFn: () => rejectRunbookRun(id, reason.trim() || undefined),
    onSuccess: (r) => {
      setRejecting(false);
      onDone("Run rejected")(r);
    },
    onError,
  });
  const cancel = useMutation({ mutationFn: () => cancelRunbookRun(id), onSuccess: onDone("Cancellation requested"), onError });
  const rerun = useMutation({
    mutationFn: (onlyFailed: boolean) => rerunRunbookRun(id, onlyFailed),
    onSuccess: onDone("Rerun requested"),
    onError,
  });

  if (run.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (run.error || !run.data) return <div className="p-6 text-sm text-destructive">{(run.error as Error)?.message ?? "Run not found"}</div>;

  const r: RunbookRunDetailDto = run.data;
  const userId = session?.user?.id;
  const active = isRunbookRunActive(r.status);
  const isRequester = !!userId && r.requestedBy?.id === userId;
  const canCancel = active && !r.cancelRequestedAt && (isRequester || canApprove) && canExecute;
  const pendingApproval = r.status === "pending_approval";
  const hasFailures = r.hosts.some((h) => h.status !== "succeeded");

  const toggle = (hostId: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(hostId)) n.delete(hostId);
      else n.add(hostId);
      return n;
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/runbooks">
            <ArrowLeft className="h-4 w-4" /> Runbooks
          </Link>
        </Button>
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight">
            <Link to="/runbooks/$runbookId" params={{ runbookId: String(r.runbookId) }} className="hover:underline">
              {r.runbookName}
            </Link>
            <span className="font-mono text-base text-muted-foreground">#{r.id}</span>
            <RunStatusBadge status={r.status} />
            {r.dryRun && <Badge variant="outline">dry run</Badge>}
            {r.runAs === "root" && <Badge variant="destructive">root</Badge>}
          </h1>
          <p className="text-xs text-muted-foreground">
            v{r.runbookVersion} · {r.triggeredBy === "schedule" ? "scheduled" : `requested by ${r.requestedBy?.name ?? "unknown"}`}
            {r.triggeredBy === "api" ? " (API key)" : ""} · {timeAgo(r.createdAt)}
            {r.approvedBy && ` · approved by ${r.approvedBy.name}`}
            {r.rejectedBy && ` · rejected by ${r.rejectedBy.name}`}
            {r.cancelledBy && ` · cancelled by ${r.cancelledBy.name}`}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {pendingApproval && canApprove && !isRequester && (
            <>
              <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
                <Check className="h-4 w-4" /> Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
                <X className="h-4 w-4" /> Reject
              </Button>
            </>
          )}
          {canCancel && (
            <Button size="sm" variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              <Ban className="h-4 w-4" /> Cancel
            </Button>
          )}
          {!active && canExecute && (
            <>
              {hasFailures && (
                <Button size="sm" variant="outline" onClick={() => rerun.mutate(true)} disabled={rerun.isPending}>
                  <RotateCcw className="h-4 w-4" /> Rerun failed
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => rerun.mutate(false)} disabled={rerun.isPending}>
                <RotateCcw className="h-4 w-4" /> Rerun
              </Button>
            </>
          )}
        </div>
      </div>

      {pendingApproval && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Waiting for approval{r.approvalExpiresAt ? ` until ${new Date(r.approvalExpiresAt).toLocaleString()}` : ""}.
          {isRequester && canApprove && " You requested this run, so a different admin must approve it."}
        </div>
      )}
      {r.cancelRequestedAt && r.status === "running" && (
        <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm">Cancelling — hosts are being stopped…</div>
      )}
      {r.error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{r.error}</div>}
      {r.rejectionReason && <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm">Rejection reason: {r.rejectionReason}</div>}

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Hosts", r.summary?.total ?? r.hosts.length],
          ["Succeeded", r.summary?.succeeded ?? r.hosts.filter((h) => h.status === "succeeded").length],
          ["Failed", r.summary ? r.summary.failed + r.summary.timedOut : r.hosts.filter((h) => h.status === "failed" || h.status === "timed_out").length],
          ["Duration", formatDuration(r.startedAt ? (r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now()) - new Date(r.startedAt).getTime() : null)],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border border-white/10 bg-card/60 px-4 py-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      {Object.keys(r.params).length > 0 && (
        <div className="rounded-xl border border-white/10 bg-card/60 px-4 py-3">
          <div className="mb-2 text-sm font-semibold">Parameters</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(r.params).map(([k, v]) => (
              <code key={k} className="rounded bg-white/5 px-2 py-0.5 text-xs">
                {k}={v}
              </code>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-card/60 shadow-xl">
        <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold" onClick={() => setShowScript((s) => !s)}>
          {showScript || pendingApproval ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Script (as requested, v{r.runbookVersion})
          {r.currentScript !== null && <Badge variant="warning">runbook changed since (now v{r.currentVersion})</Badge>}
        </button>
        {(showScript || pendingApproval) && (
          <div className="space-y-3 px-4 pb-4">
            <pre className="max-h-96 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs">{r.dryRun ? "(dry run: connectivity probe only)" : r.scriptSnapshot}</pre>
            {r.currentScript !== null && !r.dryRun && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  This run executes the script above. Changes in the current version (lines marked + are not part of this run):
                </div>
                <ScriptDiff snapshot={r.scriptSnapshot} current={r.currentScript} />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-white/10 bg-card/60 shadow-xl">
        <div className="border-b border-white/8 px-4 py-3 text-sm font-semibold">Hosts</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-4 py-2" />
              <th className="px-2 py-2 font-medium">Host</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Exit</th>
              <th className="px-2 py-2 font-medium">Duration</th>
              <th className="px-2 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {r.hosts.map((h) => {
              const open = expanded.has(h.id);
              const canOpen = h.serverId !== null;
              return (
                <Fragment key={h.id}>
                  <tr className={canOpen ? "cursor-pointer hover:bg-white/5" : ""} onClick={() => canOpen && toggle(h.id)}>
                    <td className="px-4 py-2">{canOpen && (open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)}</td>
                    <td className="px-2 py-2 font-medium">{h.hostname}</td>
                    <td className="px-2 py-2">
                      <HostStatusBadge status={h.status} />
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">{h.exitCode ?? "—"}</td>
                    <td className="px-2 py-2 text-xs">{formatDuration(h.durationMs)}</td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {h.errorCode && (
                        <span title={HOST_ERROR_HINTS[h.errorCode]}>
                          <code className="text-destructive">{h.errorCode}</code> {HOST_ERROR_HINTS[h.errorCode]}
                        </span>
                      )}
                      {!h.errorCode && (h.stdoutLength > 0 || h.stderrLength > 0) && `${h.stdoutLength + h.stderrLength} chars of output`}
                    </td>
                  </tr>
                  {open && h.serverId !== null && (
                    <tr>
                      <td />
                      <td colSpan={5} className="px-2 pb-4">
                        <HostOutput runId={r.id} serverId={h.serverId} live={h.status === "running" || h.status === "pending"} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject run #{r.id}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Reason (optional)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why this should not run" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}>
                Reject
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
