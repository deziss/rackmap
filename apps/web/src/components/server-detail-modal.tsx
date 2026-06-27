import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchServer, fetchServerMetrics, serverKeys, revealPassword, systemKeys, fetchMe } from "@/lib/queries";
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
  Terminal, Copy, Check, ShieldCheck, Server, Lock, Activity, Globe, Tag
} from "lucide-react";
import { toast } from "sonner";
import type { ProcInfo } from "@inv/shared";

function InfoRow({ label, value, icon: Icon }: { label: string; value: React.ReactNode; icon?: React.ElementType }) {
  return (
    <div className="flex py-3 border-b border-border/50 last:border-0 items-start">
      <div className="w-1/3 text-muted-foreground text-sm flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4" />}
        {label}
      </div>
      <div className="w-2/3 text-sm font-medium break-all">
        {value || <span className="text-muted-foreground/50 italic">—</span>}
      </div>
    </div>
  );
}

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

function PasswordBox({ serverId }: { serverId: number }) {
  const [pwd, setPwd] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleReveal() {
    setLoading(true);
    try {
      const res = await revealPassword(serverId);
      setPwd(res.password);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to reveal password");
    } finally {
      setLoading(false);
    }
  }

  if (pwd) {
    return (
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm truncate" title={pwd}>{pwd}</span>
        <Button size="icon" variant="ghost" className="h-4 w-4" onClick={() => void navigator.clipboard.writeText(pwd).then(() => toast.success("Copied"))}>
          <Copy className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" variant="ghost" className="h-5 px-1.5 text-xs text-muted-foreground -ml-1.5" onClick={handleReveal} disabled={loading}>
      {loading ? "Revealing..." : "Reveal"}
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
  
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe });
  const sshEnabled = me?.features?.sshEnabled ?? true;
  
  const canSsh = sshEnabled && (session?.user?.role === "admin" || session?.user?.role === "editor");

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
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col p-0 gap-0 overflow-hidden [&>button:last-child]:top-3 [&>button:last-child]:right-3">
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
              {server && sshEnabled && <CopySSHBtn server={server as { ip: string; username: string; sshPort: number }} />}
              {server && sshEnabled && <CopySSHBtn server={server as { ip: string; username: string; sshPort: number }} sudo />}
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

          {server && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Connection & Network */}
              <Card className="border-border/60 bg-card/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Server className="h-4 w-4 text-primary" /> Connection Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <InfoRow label="Hostname" value={server.hostname} />
                  <InfoRow label="IP Address" value={server.ip} />
                  <InfoRow label="Private IP" value={server.isPrivateIp ? "Yes" : "No"} />
                  <InfoRow label="Domain" value={server.domain} icon={Globe} />
                </CardContent>
              </Card>

              {/* Identity & Access */}
              <Card className="border-border/60 bg-card/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Lock className="h-4 w-4 text-primary" /> Authentication
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <InfoRow label="Username" value={server.username} />
                  <InfoRow label="SSH Port" value={String(server.sshPort)} />
                  <InfoRow label="Password" value={<PasswordBox key="pwd" serverId={server.id} />} />
                </CardContent>
              </Card>

              {/* Specifications */}
              <Card className="border-border/60 bg-card/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <HardDrive className="h-4 w-4 text-primary" /> Specifications
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <InfoRow label="OS Type" value={server.osType} />
                  <InfoRow label="CPU" value={server.cpu} icon={Cpu} />
                  <InfoRow label="RAM" value={server.ram} icon={MemoryStick} />
                  <InfoRow label="GPU Count" value={server.gpuCount != null ? String(server.gpuCount) : null} icon={Zap} />
                  <InfoRow label="GPU Type" value={(server.gpuType as { name?: string } | null)?.name} />
                </CardContent>
              </Card>

              {/* Environment & Allocation */}
              <Card className="border-border/60 bg-card/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" /> Assignment & Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <InfoRow label="Environment" value={server.environment} />
                  <InfoRow label="Cloud Provider" value={(server.cloudProvider as { name?: string } | null)?.name} />
                  <InfoRow label="Location" value={(server.location as { name?: string } | null)?.name} />
                  <InfoRow label="Allocated To" value={(server.allocatedTo as { name?: string } | null)?.name} />
                  <InfoRow label="Created By" value={server.createdBy} />
                </CardContent>
              </Card>

              {/* Remark */}
              {server.remark && (
                <Card className="border-border/60 bg-card/50 md:col-span-2">
                  <CardContent className="pt-5">
                    <InfoRow label="Remark" value={<span className="whitespace-pre-wrap">{server.remark}</span>} />
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Tags */}
          {server && (server.tags as { id: number; name: string; color?: string | null }[]).length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-muted-foreground">
                <Tag className="h-4 w-4" /> Attached Tags
              </h3>
              <div className="flex flex-wrap gap-2">
                {(server.tags as { id: number; name: string; color?: string | null }[]).map((t) => (
                  <Badge
                    key={t.id}
                    variant="outline"
                    className="px-2 py-0.5 text-xs"
                    style={t.color ? { backgroundColor: t.color + "22", borderColor: t.color + "55", color: t.color } : {}}
                  >
                    {t.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Metrics */}
          {sshEnabled && metricsQ.isError && (
            <Card className="border-destructive/50">
              <CardContent className="flex items-center gap-2 py-3 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>Live metrics unavailable — {metricsQ.error instanceof Error ? metricsQ.error.message : "host unreachable over SSH or no credentials configured."}</span>
              </CardContent>
            </Card>
          )}
          {sshEnabled && metricsQ.isLoading && (
            <p className="text-sm text-muted-foreground py-4 text-center">Connecting over SSH to collect metrics…</p>
          )}
          {sshEnabled && m && (
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
