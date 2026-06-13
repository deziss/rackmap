import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchServer, fetchServerMetrics, serverKeys } from "@/lib/queries";
import { authClient } from "@/lib/auth-client";
import { StatusDot } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SshTerminal } from "@/components/ssh-terminal";
import { cn } from "@/lib/utils";
import { ArrowLeft, Cpu, MemoryStick, HardDrive, Network, Zap, AlertTriangle, Terminal, Copy, Check, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { ProcInfo } from "@inv/shared";

export const Route = createFileRoute("/_auth/servers/$serverId")({
  component: ServerDetailPage,
});

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-muted">
      <div
        className={cn("h-full rounded transition-all", color ?? "bg-primary")}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
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

function CopySSHButton({ server, sudo = false }: { server: { ip: string; username: string; sshPort: number }; sudo?: boolean }) {
  const [copied, setCopied] = useState(false);
  const cmd = sudo
    ? `ssh -p ${server.sshPort} ${server.username}@${server.ip} -t sudo su -`
    : `ssh -p ${server.sshPort} ${server.username}@${server.ip}`;
  const copy = () => {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      toast.success("SSH command copied");
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Button size="sm" variant="outline" className="gap-1.5 font-mono text-xs h-8" onClick={copy} title={cmd}>
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : sudo ? <ShieldCheck className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {sudo ? "sudo" : "Copy SSH"}
    </Button>
  );
}

function ServerDetailPage() {
  const { serverId } = Route.useParams();
  const id = Number(serverId);
  const [showTerminal, setShowTerminal] = useState(false);
  const { data: session } = authClient.useSession();
  const canSsh = session?.user?.role === "admin" || session?.user?.role === "editor";

  const { data: server } = useQuery({
    queryKey: serverKeys.detail(id),
    queryFn: () => fetchServer(id),
  });

  const metricsQ = useQuery({
    queryKey: serverKeys.metrics(id),
    queryFn: () => fetchServerMetrics(id),
    refetchInterval: 5000,
    retry: false,
  });

  const m = metricsQ.data;
  const cpuLoadPct = m ? (m.cpu.loadAvg1 / Math.max(1, m.cpu.cores)) * 100 : 0;
  const memPct = m && m.mem.totalMb > 0 ? (m.mem.usedMb / m.mem.totalMb) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/servers">
          <Button size="sm" variant="ghost" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Servers
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          {server && <StatusDot status={server.lastStatus as "up" | "down" | "unknown"} latencyMs={server.lastLatencyMs} ip={server.ip} port={server.sshPort} />}
          <h1 className="text-xl font-semibold font-mono">{server?.hostname ?? `Server #${id}`}</h1>
        </div>
        {server?.domain && <Badge variant="secondary" className="text-xs">{server.domain}</Badge>}
        {server?.environment && <Badge variant="secondary" className="text-xs uppercase">{server.environment}</Badge>}
        {server?.cloudProvider && <Badge variant="secondary" className="text-xs">{server.cloudProvider.name}</Badge>}
        {server?.location && <Badge variant="outline" className="text-xs">{server.location.name}</Badge>}
        <span className="text-sm text-muted-foreground font-mono ml-auto">{server?.ip}:{server?.sshPort}</span>
        {server && (
          <>
            <CopySSHButton server={server as { ip: string; username: string; sshPort: number }} />
            <CopySSHButton server={server as { ip: string; username: string; sshPort: number }} sudo />
          </>
        )}
        {canSsh && (
          <Button
            size="sm"
            variant={showTerminal ? "secondary" : "default"}
            className="gap-2"
            onClick={() => setShowTerminal(!showTerminal)}
          >
            <Terminal className="h-4 w-4" />
            {showTerminal ? "Close Terminal" : "SSH Terminal"}
          </Button>
        )}
      </div>

      {/* Terminal */}
      {showTerminal && canSsh && (
        <SshTerminal serverId={id} onClose={() => setShowTerminal(false)} />
      )}

      {/* Metrics unreachable banner */}
      {metricsQ.isError && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Could not collect live metrics — host unreachable over SSH or no stored credentials. Inventory data above is still accurate.
          </CardContent>
        </Card>
      )}

      {metricsQ.isLoading && (
        <p className="text-sm text-muted-foreground py-8 text-center">Connecting over SSH to collect metrics…</p>
      )}

      {m && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* CPU */}
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Cpu className="h-4 w-4" /> CPU — top 10 by usage</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 space-y-3">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>Load: <span className="font-mono text-foreground">{m.cpu.loadAvg1.toFixed(2)} / {m.cpu.loadAvg5.toFixed(2)} / {m.cpu.loadAvg15.toFixed(2)}</span></span>
                <span>{m.cpu.cores} cores</span>
              </div>
              <Bar pct={cpuLoadPct} color={cpuLoadPct > 90 ? "bg-red-500" : cpuLoadPct > 70 ? "bg-yellow-500" : "bg-green-500"} />
              <ProcTable procs={m.topCpu} kind="cpu" />
            </CardContent>
          </Card>

          {/* Memory */}
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><MemoryStick className="h-4 w-4" /> Memory — top 10 by usage</CardTitle>
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

          {/* GPU */}
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4" /> GPU</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 space-y-3">
              {!m.hasGpu ? (
                <p className="text-xs text-muted-foreground">No GPU detected (nvidia-smi unavailable)</p>
              ) : (
                <>
                  {m.gpus.map((g) => {
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
                  {m.gpuProcs.length > 0 && (
                    <table className="w-full text-xs mt-2">
                      <thead>
                        <tr className="text-muted-foreground"><th className="text-left font-medium pb-1">PID</th><th className="text-left font-medium pb-1">Process</th><th className="text-right font-medium pb-1">VRAM</th></tr>
                      </thead>
                      <tbody>
                        {m.gpuProcs.map((p) => (
                          <tr key={p.pid} className="border-t border-border/50">
                            <td className="py-0.5 text-muted-foreground font-mono">{p.pid}</td>
                            <td className="py-0.5 font-mono truncate max-w-[12rem]">{p.name}</td>
                            <td className="py-0.5 text-right font-mono">{p.memMb} MB</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Disk + Network stacked */}
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
                      <tr className="text-muted-foreground"><th className="text-left font-medium pb-1">Interface</th><th className="text-right font-medium pb-1">↓ RX/s</th><th className="text-right font-medium pb-1">↑ TX/s</th></tr>
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
  );
}
