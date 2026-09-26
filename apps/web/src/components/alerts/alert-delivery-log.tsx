import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ALERT_DELIVERY_STATUSES, ALERT_EVENT_LABELS, type AlertChannelDto, type AlertDeliveryStatus } from "@inv/shared";
import { Loader2, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { alertsKeys, fetchAlertDeliveries } from "@/lib/alerts-api";
import { DeliveryStatusBadge } from "./channel-type-icon";

/**
 * Delivery log for one channel: every attempt outcome the dispatcher
 * recorded, newest first. Errors are stored sanitized (no URLs or tokens),
 * so they are safe to show as-is.
 */
export function AlertDeliveryLog({
  channel,
  open,
  onOpenChange,
}: {
  channel: AlertChannelDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<AlertDeliveryStatus | "all">("all");
  const id = channel?.id ?? 0;
  const q = useInfiniteQuery({
    queryKey: alertsKeys.deliveries(id, status === "all" ? undefined : status),
    queryFn: ({ pageParam }) =>
      fetchAlertDeliveries(id, { status: status === "all" ? undefined : status, cursor: pageParam ?? undefined, limit: 50 }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open && !!channel,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Delivery log — {channel?.name}</DialogTitle>
          <DialogDescription>Each alert this channel was due to receive, with its latest attempt.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(v) => setStatus(v as AlertDeliveryStatus | "all")}>
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {ALERT_DELIVERY_STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="rounded-lg border border-white/10 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/8 bg-white/3 text-left text-muted-foreground uppercase tracking-wider">
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">Event</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Attempts</th>
                <th className="px-3 py-2 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {q.isLoading && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    <Loader2 className="inline h-4 w-4 animate-spin" />
                  </td>
                </tr>
              )}
              {!q.isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    No deliveries yet.
                  </td>
                </tr>
              )}
              {rows.map((d) => (
                <tr key={d.id} className="border-b border-white/5 last:border-0 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground" title={new Date(d.createdAt).toLocaleString()}>
                    {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{d.event.title}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {ALERT_EVENT_LABELS[d.event.type] ?? d.event.type} · {d.event.severity}
                      {d.event.action !== "info" ? ` · ${d.event.action}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <DeliveryStatusBadge status={d.status} />
                    {d.status === "retrying" && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        next {formatDistanceToNow(new Date(d.nextAttemptAt), { addSuffix: true })}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {d.attempts}/{d.maxAttempts}
                  </td>
                  <td className="px-3 py-2 max-w-xs">
                    {d.lastStatusCode !== null && <span className="font-mono mr-1">{d.lastStatusCode}</span>}
                    <span className="text-muted-foreground break-words">{d.lastError ?? (d.status === "succeeded" ? "Delivered" : "")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {q.hasNextPage && (
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Load more
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
