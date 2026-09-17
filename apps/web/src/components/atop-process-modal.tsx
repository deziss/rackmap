import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, Search, Loader2, AlertCircle } from "lucide-react";
import { fetchAtopIntervalProcesses } from "@/lib/queries";
import type { AtopIntervalSnapshot } from "@inv/shared";

interface AtopProcessModalProps {
  serverId: number;
  snapshot: AtopIntervalSnapshot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AtopProcessModal({ serverId, snapshot, open, onOpenChange }: AtopProcessModalProps) {
  const [filter, setFilter] = useState("");

  const snapshotDate = snapshot?.dateTime ? snapshot.dateTime.split(" ")[0] || "today" : "today";
  const snapshotTime = snapshot?.dateTime ? snapshot.dateTime.split(" ")[1] || snapshot.dateTime : "";

  const { data, isLoading, error } = useQuery({
    queryKey: ["servers", serverId, "atop-processes", snapshotDate, snapshotTime],
    queryFn: () => fetchAtopIntervalProcesses(serverId, snapshotDate, snapshotTime),
    enabled: open && !!snapshot,
  });

  if (!snapshot) return null;

  const procs = (data?.processes ?? snapshot.topProcesses ?? []).filter((p) =>
    filter ? p.name.toLowerCase().includes(filter.toLowerCase()) || String(p.pid).includes(filter) : true
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[750px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between pr-4">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
                <Activity className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-base flex items-center gap-2">
                  ATOP Snapshot Interval Drill-down
                  <Badge variant="outline" className="font-mono text-xs">
                    {snapshot.dateTime}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Top resource-consuming processes captured during this sample window.
                </DialogDescription>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Snapshot Summary Chips */}
        <div className="grid grid-cols-4 gap-2 text-xs py-2 border-y my-1">
          <div className="p-2 rounded bg-muted/40 border">
            <span className="text-muted-foreground block text-[10px]">CPU Total</span>
            <span className="font-mono font-semibold text-xs">{snapshot.cpu.totalPct.toFixed(1)}%</span>
            <span className="text-[10px] text-muted-foreground ml-1">({snapshot.cpu.sysPct}% sys)</span>
          </div>
          <div className="p-2 rounded bg-muted/40 border">
            <span className="text-muted-foreground block text-[10px]">Memory Used</span>
            <span className="font-mono font-semibold text-xs">
              {(snapshot.mem.totalMb / 1024).toFixed(1)} GB
            </span>
            <span className="text-[10px] text-muted-foreground ml-1">
              ({snapshot.mem.usedPct.toFixed(0)}%)
            </span>
          </div>
          <div className="p-2 rounded bg-muted/40 border">
            <span className="text-muted-foreground block text-[10px]">Disk Busy</span>
            <span className="font-mono font-semibold text-xs">{snapshot.dsk.busyPct.toFixed(1)}%</span>
            <span className="text-[10px] text-muted-foreground ml-1">
              ({snapshot.dsk.readSectors + snapshot.dsk.writeSectors} sec)
            </span>
          </div>
          <div className="p-2 rounded bg-muted/40 border">
            <span className="text-muted-foreground block text-[10px]">Network Total</span>
            <span className="font-mono font-semibold text-xs">
              {(snapshot.net.inKbps + snapshot.net.outKbps).toFixed(0)} Kbps
            </span>
          </div>
        </div>

        {/* Search and Table */}
        <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter processes by name or PID..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-8 h-8 text-xs font-mono"
            />
          </div>

          <div className="flex-1 overflow-y-auto rounded border border-border/70 min-h-[220px]">
            {isLoading ? (
              <div className="h-48 flex items-center justify-center gap-2 text-muted-foreground text-xs">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Reading process snapshot from atop log archive...</span>
              </div>
            ) : error ? (
              <div className="h-48 flex items-center justify-center text-destructive text-xs gap-1.5 p-4 text-center">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{(error as any)?.message || "Failed to load interval processes"}</span>
              </div>
            ) : procs.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-muted-foreground text-xs">
                No active processes found matching criteria for this snapshot.
              </div>
            ) : (
              <table className="w-full text-xs text-left">
                <thead className="sticky top-0 bg-muted/90 backdrop-blur border-b text-muted-foreground text-[11px]">
                  <tr>
                    <th className="py-1.5 px-2.5 font-medium">PID</th>
                    <th className="py-1.5 px-2.5 font-medium">Command</th>
                    <th className="py-1.5 px-2.5 font-medium text-right">CPU%</th>
                    <th className="py-1.5 px-2.5 font-medium text-right">Memory%</th>
                    <th className="py-1.5 px-2.5 font-medium text-right">Disk Read/Write</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40 font-mono text-[11px]">
                  {procs.map((p) => (
                    <tr key={`${p.pid}-${p.name}`} className="hover:bg-muted/30">
                      <td className="py-1.5 px-2.5 text-muted-foreground">{p.pid}</td>
                      <td className="py-1.5 px-2.5 font-semibold text-foreground truncate max-w-[240px]" title={p.name}>
                        {p.name}
                      </td>
                      <td className="py-1.5 px-2.5 text-right font-semibold text-amber-500">
                        {p.cpuPct.toFixed(1)}%
                      </td>
                      <td className="py-1.5 px-2.5 text-right text-muted-foreground">
                        {p.memPct.toFixed(1)}%
                      </td>
                      <td className="py-1.5 px-2.5 text-right text-muted-foreground">
                        {p.readDsk} / {p.writeDsk}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
