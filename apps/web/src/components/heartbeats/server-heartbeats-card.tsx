import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Activity, Loader2, Plus } from "lucide-react";
import { fetchHeartbeats, heartbeatKeys } from "@/lib/heartbeats-api";
import { HeartbeatFormDialog } from "./heartbeat-form-dialog";
import { PingSparkline } from "./ping-sparkline";
import { HeartbeatStatusDot, describeHeartbeatSchedule, relativeTime, useHeartbeatPermissions } from "./heartbeat-status";

/** Heartbeats linked to one server, for the server detail page. */
export function ServerHeartbeatsCard({ serverId }: { serverId: number }) {
  const perms = useHeartbeatPermissions();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: heartbeatKeys.list({ serverId }),
    queryFn: () => fetchHeartbeats({ serverId }),
    refetchInterval: 30_000,
  });
  const items = data?.items ?? [];

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-emerald-500" />
          Heartbeats
          {items.length > 0 && <span className="text-xs font-normal text-muted-foreground">({items.length})</span>}
        </CardTitle>
        {perms.canCreate && (
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New heartbeat
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-4 pt-2">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading heartbeats…
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No heartbeats for this server. Turn on "Monitor this job" for an entry in the Cron tab, or create one for any scheduled job.
          </p>
        ) : (
          <ul className="divide-y divide-white/5">
            {items.map((hb) => (
              <li key={hb.id} className="flex items-center gap-3 py-2">
                <HeartbeatStatusDot status={hb.status} />
                <div className="min-w-0 flex-1">
                  <Link
                    to="/heartbeats/$heartbeatId"
                    params={{ heartbeatId: String(hb.id) }}
                    className="block truncate text-xs font-medium hover:underline"
                  >
                    {hb.name}
                  </Link>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {describeHeartbeatSchedule(hb)} · last ping {relativeTime(hb.lastPingAt)}
                  </div>
                </div>
                <PingSparkline pings={hb.recentPings ?? []} max={20} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <HeartbeatFormDialog open={creating} onOpenChange={setCreating} defaultServerId={serverId} />
    </Card>
  );
}
