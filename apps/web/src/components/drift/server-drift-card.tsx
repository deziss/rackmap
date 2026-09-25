import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DRIFT_CATEGORIES, DRIFT_CATEGORY_LABELS, type DriftEventDto } from "@inv/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { AlertTriangle, CheckCircle2, GitCompareArrows, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  acceptServerDriftBaseline,
  acknowledgeDriftEvent,
  driftKeys,
  fetchServerDrift,
  scanServerDrift,
} from "@/lib/drift-api";
import { ApiError } from "@/lib/api";
import { DriftEventRow, relativeTime, useDriftPermissions } from "./drift-ui";

/** Configuration drift for one server: baseline, last scan, open events, scan / accept actions. */
export function ServerDriftCard({ serverId }: { serverId: number }) {
  const qc = useQueryClient();
  const perms = useDriftPermissions();
  const [confirmBaseline, setConfirmBaseline] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: driftKeys.server(serverId),
    queryFn: () => fetchServerDrift(serverId),
    enabled: perms.canRead,
    refetchInterval: 60_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: driftKeys.all });

  const scan = useMutation({
    mutationFn: () => scanServerDrift(serverId),
    onSuccess: (r) => {
      if (r.baselineCreated) toast.success("First snapshot taken and stored as the baseline");
      else if (r.events.length > 0) toast.warning(`Drift detected: ${r.events.length} new event${r.events.length === 1 ? "" : "s"}`);
      else if (r.driftedCategories.length > 0) toast.info("No new drift; earlier differences from the baseline remain");
      else toast.success("No drift: the server matches its baseline");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const baseline = useMutation({
    mutationFn: () => acceptServerDriftBaseline(serverId),
    onSuccess: (r) => {
      toast.success(`Baseline updated${r.acknowledged ? `; ${r.acknowledged} open event${r.acknowledged === 1 ? "" : "s"} acknowledged` : ""}`);
      setConfirmBaseline(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ack = useMutation({
    mutationFn: (ev: DriftEventDto) => acknowledgeDriftEvent(ev.id),
    onSuccess: () => {
      toast.success("Event acknowledged");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!perms.canRead) return null;

  const latest = data?.latest ?? null;
  const unavailable = latest
    ? DRIFT_CATEGORIES.filter((c) => latest.unavailable[c]).map((c) => ({ c, why: latest.unavailable[c]! }))
    : [];

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0 gap-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <GitCompareArrows className="h-4 w-4 text-primary" />
          Configuration drift
          {data && data.openCounts.total > 0 && (
            <span className="text-xs font-normal text-muted-foreground">({data.openCounts.total} open)</span>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          {perms.canAcknowledge && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              disabled={scan.isPending}
              onClick={() => scan.mutate()}
            >
              {scan.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Scan now
            </Button>
          )}
          {perms.canBaseline && latest && !latest.isBaseline && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setConfirmBaseline(true)}>
              <ShieldCheck className="h-3.5 w-3.5" /> Accept as baseline
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading drift status…
          </div>
        ) : error ? (
          <p className="text-xs text-red-400">{error instanceof ApiError ? error.message : "Could not load drift status"}</p>
        ) : !latest ? (
          <p className="text-xs text-muted-foreground">
            Not scanned yet. The first scan records users, sudoers rules, crontabs, listening ports, enabled units and
            authorized SSH keys as this server's baseline; later scans report anything that differs from it.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Baseline</dt>
              <dd title={data?.baseline?.takenAt}>{data?.baseline ? relativeTime(data.baseline.takenAt) : "—"}</dd>
              <dt className="text-muted-foreground">Last scan</dt>
              <dd title={latest.takenAt}>
                {relativeTime(latest.takenAt)}
                {!latest.ranAsRoot && <span className="text-amber-400"> (without root)</span>}
              </dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                {data?.matchesBaseline ? (
                  <span className="inline-flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Matches baseline
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" /> Differs from baseline
                  </span>
                )}
              </dd>
            </dl>

            {unavailable.length > 0 && (
              <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                <p className="font-medium">Not checked in the last scan:</p>
                <ul className="mt-0.5 list-disc pl-4">
                  {unavailable.map(({ c, why }) => (
                    <li key={c}>
                      {DRIFT_CATEGORY_LABELS[c]}: {why}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {latest.warnings.length > 0 && (
              <ul className="list-disc pl-4 text-[11px] text-muted-foreground">
                {latest.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            {data && data.openEvents.length > 0 ? (
              <ul className="divide-y divide-white/5">
                {data.openEvents.map((ev) => (
                  <DriftEventRow
                    key={ev.id}
                    event={ev}
                    canAcknowledge={perms.canAcknowledge}
                    onAcknowledge={(e) => ack.mutate(e)}
                    acknowledging={ack.isPending && ack.variables?.id === ev.id}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No open drift events.</p>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmBaseline} onOpenChange={setConfirmBaseline}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Accept the last scan as the baseline?</AlertDialogTitle>
            <AlertDialogDescription>
              The snapshot from {latest ? relativeTime(latest.takenAt) : "the last scan"} becomes what this server is compared
              against, and every open drift event is acknowledged. Anything in it — including new root keys, sudoers rules
              or privileged group members — will be treated as normal from now on. Run "Scan now" first if the last scan is
              out of date.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={baseline.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={baseline.isPending}
              onClick={(e) => {
                e.preventDefault();
                baseline.mutate();
              }}
            >
              {baseline.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Accept as baseline
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
