import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchServer, fetchServerMetrics, serverKeys } from "@/lib/queries";
import { authClient } from "@/lib/auth-client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusDot } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SshTerminal } from "@/components/ssh-terminal";
import { cn } from "@/lib/utils";
import {
  Cpu, MemoryStick, HardDrive, Network, Zap, AlertTriangle,
  Terminal, Copy, Check, ShieldCheck, Server,
} from "lucide-react";
import { toast } from "sonner";
import type { ProcInfo } from "@inv/shared";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={cn("h-full rounded-full transition-all", color ?? "bg-primary")} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function ProcTable({ procs, kind }: { procs: ProcInfo[]; kind: "cpu" | "mem" }) {
  if (procs.length === 0) return <p className="text-xs text-muted-foreground">No process data</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="text-left font-medium pb-1">PID</th>
          <th className="text-left font-medium pb-1">Process</th>
          <th className="text-right font-medium pb-1">CPU%</th>
          <th className="text-right font-medium pb-1">MEM%</th>
        </tr>
      </thead>
      <tbody>
        {procs.map((p) => (
          <tr key={p.pid} className="border-t border-border/50">
            <td className="py-0.5 text-muted-foreground font-mono">{p.pid}</td>
            <td className="py-0.5 font-mono truncate max-w-[12rem]">{p.comm}</td>
            <td className={cn("py-0.5 text-right font-mono", kind === "cpu" && "font-semibold")}>{p.cpu.toFixed(1)}</td>
            <td className={cn("py-0.5 text-right font-mono", kind === "mem" && "font-semibold")}>{p.mem.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CopySSHBtn({ server, sudo = false }: { server: { ip: string; username: string; sshPort: number }; sudo?: boolean }) {
  const [copied, setCopied] = useState(false);
  const cmd = sudo
    ? `ssh -p ${server.sshPort} ${server.username}@${server.ip} -t sudo su -`
    : `ssh -p ${server.sshPort} ${server.username}@${server.ip}`;
  return (
    <Button size="sm" variant="outline" className="gap-1.5 font-mono text-xs h-8"
      onClick={() => void navigator.clipboard.writeText(cmd).then(() => { setCopied(true); toast.success("Copied"); setTimeout(() => setCopied(false), 2000); })}>
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : sudo ? <ShieldCheck className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {sudo ? "sudo" : "Copy SSH"}
    </Button>
  );
}

interface ServerDetailModalProps {
  serverId: number | null;
  onClose: () => void;
}

export function ServerDetailModal({ serverId, onClose }: ServerDetailModalProps) {
  const [showTerminal, setShowTerminal] = useState(false);
  const { data: session } = authClient.useSession();
  const canSsh = session?.user?.role === "admin" || session?.user?.role === "editor";

  const { data: server } = useQuery({
    queryKey: serverKeys.detail(serverId ?? 0),
    queryFn: () => fetchServer(serverId!),
    enabled: serverId != null,
  });

  const metricsQ = useQuery({
    queryKey: serverKeys.metrics(serverId ?? 0),
    queryFn: () => fetchServerMetrics(serverId!),
    refetchInterval: 5000,
    retry: false,
    enabled: serverId != null,
  });

  const m = metricsQ.data;
  const cpuPct = m ? (m.cpu.loadAvg1 / Math.max(1, m.cpu.cores)) * 100 : 0;
  const memPct = m && m.mem.totalMb > 0 ? (m.mem.usedMb / m.mem.totalMb) * 100 : 0;

  return (
    <Dialog open={serverId != null} onOpenChange={(open) => { if (!open) { setShowTerminal(false); onClose(); } }}>
      <DialogContent className="max-w-[96vw] w-full h-[94vh] flex flex-col p-0 gap-0 overflow-hidden [&>button:last-child]:top-3 [&>button:last-child]:right-3">
        {/* Header */}
        <DialogHeader className="shrink-0 px-5 py-3 border-b border-border bg-card/80 backdrop-blur-sm">
          <div className="flex items-center gap-3 flex-wrap pr-8">
            <Server className="h-4 w-4 text-muted-foreground shrink-0" />
            <DialogTitle className="font-mono text-base flex items-center gap-2">
              {server && (
                <StatusDot
                  status={server.lastStatus as "up" | "down" | "unknown"}
                  latencyMs={server.lastLatencyMs}
                  ip={server.ip}
                  port={server.sshPort}
                />
              )}
              {server?.hostname ?? `Server #${serverId}`}
            </DialogTitle>
            {server?.domain && <Badge variant="secondary" className="text-xs">{server.domain}</Badge>}
            {server?.environment && <Badge variant="secondary" className="text-xs uppercase">{server.environment}</Badge>}
            {server?.cloudProvider && <Badge variant="secondary" className="text-xs">{server.cloudProvider.name}</Badge>}
            {server?.location && <Badge variant="outline" className="text-xs">{server.location.name}</Badge>}
            <span className="text-xs text-muted-foreground font-mono ml-1">{server?.ip}:{server?.sshPort}</span>
            <div className="ml-auto flex items-center gap-2">
              {server && <CopySSHBtn server={server as { ip: string; username: string; sshPort: number }} />}
              {server && <CopySSHBtn server={server as { ip: string; username: string; sshPort: number }} sudo />}
              {canSsh && serverId != null && (
                <Button size="sm" variant={showTerminal ? "secondary" : "default"} className="gap-1.5"
                  onClick={() => setShowTerminal(!showTerminal)}>
                  <Terminal className="h-3.5 w-3.5" />
                  {showTerminal ? "Close Terminal" : "SSH Terminal"}
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* SSH Terminal */}
          {showTerminal && canSsh && serverId != null && (
            <div className="h-72">
              <SshTerminal serverId={serverId} onClose={() => setShowTerminal(false)} className="h-full rounded-lg border" />
            </div>
          )}

          {/* Server info grid */}
          {server && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {[
                ["Username", server.username],
                ["SSH Port", String(server.sshPort)],
                ["IP Address", server.ip],
                ["CPU", server.cpu ?? "—"],
                ["RAM", server.ram ?? "—"],
                ["GPU Count", server.gpuCount != null ? String(server.gpuCount) : "—"],
                ["GPU Type", (server.gpuType as { name?: string } | null)?.name ?? "—"],
                ["Allocated To", (server.allocatedTo as { name?: string } | null)?.name ?? "—"],
                ["Server Type", (server.serverType as { name?: string } | null)?.name ?? "—"],
                ["Location", (server.location as { name?: string } | null)?.name ?? "—"],
                ["Remark", server.remark ?? "—"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border/60 bg-card/50 px-3 py-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">{label}</p>
                  <p className="text-sm font-mono truncate" title={value}>{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Tags */}
          {server && (server.tags as { id: number; name: string; color?: string | null }[]).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(server.tags as { id: number; name: string; color?: string | null }[]).map((t) => (
                <Badge
                  key={t.id}
                  variant="outline"
                  className="text-xs"
                  style={t.color ? { backgroundColor: t.color + "22", borderColor: t.color + "55", color: t.color } : {}}
                >
                  {t.name}
                </Badge>
              ))}
            </div>
          )}

          {/* Metrics */}
          {metricsQ.isError && (
            <Card className="border-destructive/50">
              <CardContent className="flex items-center gap-2 py-3 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Live metrics unavailable — host unreachable over SSH or no credentials configured.
              </CardContent>
            </Card>
          )}
          {metricsQ.isLoading && (
            <p className="text-sm text-muted-foreground py-4 text-center">Connecting over SSH to collect metrics…</p>
          )}
          {m && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><Cpu className="h-4 w-4" /> CPU</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>Load: <span className="font-mono text-foreground">{m.cpu.loadAvg1.toFixed(2)} / {m.cpu.loadAvg5.toFixed(2)} / {m.cpu.loadAvg15.toFixed(2)}</span></span>
                    <span>{m.cpu.cores} cores</span>
                  </div>
                  <Bar pct={cpuPct} color={cpuPct > 90 ? "bg-red-500" : cpuPct > 70 ? "bg-yellow-500" : "bg-green-500"} />
                  <ProcTable procs={m.topCpu} kind="cpu" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><MemoryStick className="h-4 w-4" /> Memory</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{(m.mem.usedMb / 1024).toFixed(1)} / {(m.mem.totalMb / 1024).toFixed(1)} GB</span>
                    <span>{memPct.toFixed(0)}%</span>
                  </div>
                  <Bar pct={memPct} color={memPct > 90 ? "bg-red-500" : memPct > 70 ? "bg-yellow-500" : "bg-blue-500"} />
                  <ProcTable procs={m.topMem} kind="mem" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4" /> GPU</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-3">
                  {!m.hasGpu ? (
                    <p className="text-xs text-muted-foreground">No GPU (nvidia-smi unavailable)</p>
                  ) : m.gpus.map((g) => {
                    const gPct = g.memTotalMb > 0 ? (g.memUsedMb / g.memTotalMb) * 100 : 0;
                    return (
                      <div key={g.index} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium">#{g.index} {g.name}</span>
                          <span className="text-muted-foreground font-mono">{g.utilPct}% util{g.tempC != null ? ` · ${g.tempC}°C` : ""}</span>
                        </div>
                        <Bar pct={g.utilPct} color="bg-purple-500" />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>VRAM</span>
                          <span className="font-mono">{(g.memUsedMb / 1024).toFixed(1)} / {(g.memTotalMb / 1024).toFixed(1)} GB</span>
                        </div>
                        <Bar pct={gPct} color="bg-fuchsia-500" />
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card>
                  <CardHeader className="p-4 pb-2">
                    <CardTitle className="text-sm flex items-center gap-2"><HardDrive className="h-4 w-4" /> Disk</CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 space-y-2">
                    {m.disks.length === 0 ? <p className="text-xs text-muted-foreground">No filesystems</p> : m.disks.map((d) => (
                      <div key={d.mount} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono truncate max-w-[12rem]">{d.mount}</span>
                          <span className="text-muted-foreground font-mono">{fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)} ({d.pct}%)</span>
                        </div>
                        <Bar pct={d.pct} color={d.pct > 90 ? "bg-red-500" : d.pct > 75 ? "bg-yellow-500" : "bg-teal-500"} />
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="p-4 pb-2">
                    <CardTitle className="text-sm flex items-center gap-2"><Network className="h-4 w-4" /> Network</CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    {m.net.length === 0 ? <p className="text-xs text-muted-foreground">No interface data</p> : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="text-left font-medium pb-1">Interface</th>
                            <th className="text-right font-medium pb-1">↓ RX/s</th>
                            <th className="text-right font-medium pb-1">↑ TX/s</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.net.map((n) => (
                            <tr key={n.iface} className="border-t border-border/50">
                              <td className="py-0.5 font-mono">{n.iface}</td>
                              <td className="py-0.5 text-right font-mono text-green-600">{fmtBytes(n.rxBytesPerSec)}/s</td>
                              <td className="py-0.5 text-right font-mono text-blue-600">{fmtBytes(n.txBytesPerSec)}/s</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
          {m && (
            <p className="text-xs text-muted-foreground text-right">
              Updated {new Date(m.collectedAt).toLocaleTimeString()} · refreshes every 5s
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
