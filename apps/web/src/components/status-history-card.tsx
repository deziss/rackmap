import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { StatusHistoryPruneInput, StatusHistoryStats } from "@inv/shared";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const statusHistoryKeys = { stats: ["status-history", "stats"] as const };

function fetchStatusHistoryStats() {
  return apiFetch<StatusHistoryStats>("/api/v1/status-history/stats");
}

function pruneStatusHistory(input: StatusHistoryPruneInput) {
  return apiFetch<{ deleted: number }>("/api/v1/status-history/prune", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

const AGE_OPTIONS = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "0", label: "everything" },
];

function formatDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function describeInterval(ms: number) {
  if (ms <= 0) return "every probe";
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `every ${Math.round(minutes / 60)} h` : `every ${minutes} min`;
}

/**
 * Admin view of stored probe history (StatusCheck) with manual clean-up.
 * Automatic pruning still runs with the scheduler (retention days + row cap).
 */
export function StatusHistoryCard() {
  const queryClient = useQueryClient();
  const { data: stats, isLoading } = useQuery({
    queryKey: statusHistoryKeys.stats,
    queryFn: fetchStatusHistoryStats,
  });

  const [olderThanDays, setOlderThanDays] = useState("30");
  const [keepNewest, setKeepNewest] = useState("10000");
  const [pending, setPending] = useState<StatusHistoryPruneInput | null>(null);

  const mutation = useMutation({
    mutationFn: pruneStatusHistory,
    onSuccess: (res) => {
      toast.success(`Deleted ${res.deleted.toLocaleString()} status history row(s)`);
      queryClient.invalidateQueries({ queryKey: statusHistoryKeys.stats });
      setPending(null);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to clean status history");
      setPending(null);
    },
  });

  const keepNewestNumber = Number.parseInt(keepNewest, 10);
  const keepNewestValid = Number.isInteger(keepNewestNumber) && keepNewestNumber >= 0;

  const describePending = (p: StatusHistoryPruneInput) =>
    p.olderThanDays !== undefined
      ? p.olderThanDays === 0
        ? "Delete ALL stored status history?"
        : `Delete status history older than ${p.olderThanDays} day(s)?`
      : `Keep only the newest ${p.keepNewest?.toLocaleString()} row(s) and delete the rest?`;

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Database className="h-4 w-4 text-sky-500" />
          Status probe history
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Up/down probe results stored per server. New rows are written when a server's status changes, otherwise
          {stats ? ` ${describeInterval(stats.sampleIntervalMs)}` : " periodically"}.
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-4">
        {isLoading || !stats ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground">Stored rows</div>
              <div className="text-lg font-semibold tabular-nums">{stats.total.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Servers with history</div>
              <div className="text-lg font-semibold tabular-nums">{stats.servers.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Oldest</div>
              <div>{formatDate(stats.oldest)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Newest</div>
              <div>{formatDate(stats.newest)}</div>
            </div>
            <div className="col-span-2 text-muted-foreground">
              Automatic pruning keeps {stats.retentionDays} day(s)
              {stats.maxRows > 0 ? ` and at most ${stats.maxRows.toLocaleString()} rows` : ""} (
              <code>STATUS_RETENTION_DAYS</code>, <code>STATUS_MAX_ROWS</code>).
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t border-white/10 pt-3">
          <div className="space-y-1">
            <Label className="text-xs">Delete rows older than</Label>
            <Select value={olderThanDays} onValueChange={setOlderThanDays}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            disabled={mutation.isPending}
            onClick={() => setPending({ olderThanDays: Number(olderThanDays) })}
          >
            <Trash2 className="h-3.5 w-3.5" /> Clean
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="status-keep-newest">
              Keep only the newest
            </Label>
            <Input
              id="status-keep-newest"
              type="number"
              min={0}
              className="h-8 w-36 text-xs"
              value={keepNewest}
              onChange={(e) => setKeepNewest(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            disabled={mutation.isPending || !keepNewestValid}
            onClick={() => setPending({ keepNewest: keepNewestNumber })}
          >
            <Trash2 className="h-3.5 w-3.5" /> Trim
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? describePending(pending) : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              Deleted probe history cannot be recovered. Current server status is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (pending) mutation.mutate(pending);
              }}
            >
              {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
