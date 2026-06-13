import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchServers, serverKeys } from "@/lib/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Server, Wifi, WifiOff, Cloud, HardDrive, Activity, Zap } from "lucide-react";
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";
import { StatusDot } from "@/components/status-dot";

export const Route = createFileRoute("/_auth/")({
  component: DashboardPage,
});

function StatCard({
  label, value, icon: Icon, color, delay = 0, sub,
}: {
  label: string; value: number | string; icon: React.ElementType;
  color: string; delay?: number; sub?: string;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-xl border border-white/10 bg-card/60 backdrop-blur-xl p-5 shadow-xl animate-fade-up"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={`absolute inset-0 opacity-30 ${color} pointer-events-none`} />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight">{value}</p>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/10">
          <Icon className="h-5 w-5 text-foreground" />
        </div>
      </div>
    </div>
  );
}

function ServerRow({ server }: {
  server: { id: number; hostname: string; ip: string; lastStatus: string; lastLatencyMs: number | null; sshPort: number };
}) {
  const status = server.lastStatus as "up" | "down" | "unknown";
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/5 last:border-0">
      <StatusDot status={status} ip={server.ip} port={server.sshPort} size="sm" />
      <div className="flex-1 min-w-0">
        <Link
          to="/servers/$serverId"
          params={{ serverId: String(server.id) }}
          className="text-sm font-medium hover:text-primary transition-colors block truncate"
        >
          {server.hostname}
        </Link>
        <p className="text-xs text-muted-foreground font-mono truncate">{server.ip}</p>
      </div>
      {server.lastLatencyMs != null && status === "up" && (
        <span className="text-xs font-mono text-emerald-400/80 shrink-0">{server.lastLatencyMs}ms</span>
      )}
      {status === "down" && (
        <Badge variant="destructive" className="text-xs px-1.5 py-0 shrink-0">DOWN</Badge>
      )}
    </div>
  );
}

function DashboardPage() {

  const { data, isLoading } = useQuery({
    queryKey: serverKeys.list({ limit: 100 }),
    queryFn: () => fetchServers({ limit: 100 }),
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2 animate-fade-up">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const servers = data?.items ?? [];
  const total = servers.length;
  const online = servers.filter((s) => s.lastStatus === "up").length;
  const offline = servers.filter((s) => s.lastStatus === "down").length;
  const unknown = servers.filter((s) => s.lastStatus === "unknown").length;
  const cloudCount = servers.filter((s) => s.environment === "cloud").length;
  const uptimePct = total > 0 ? Math.round((online / total) * 100) : 0;

  const avgLatency = (() => {
    const up = servers.filter((s) => s.lastStatus === "up" && s.lastLatencyMs != null);
    if (!up.length) return null;
    return Math.round(up.reduce((a, s) => a + (s.lastLatencyMs ?? 0), 0) / up.length);
  })();

  const envData = [
    { name: "Cloud", value: cloudCount, color: "oklch(0.6 0.22 275)" },
    { name: "On-Premise", value: total - cloudCount, color: "oklch(0.65 0.18 145)" },
  ].filter((d) => d.value > 0);

  const providerCounts = servers.reduce((acc, s) => {
    if (s.cloudProvider) acc[s.cloudProvider.name] = (acc[s.cloudProvider.name] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const providerData = Object.entries(providerCounts).map(([name, count]) => ({ name, count }));

  const gpuFleet = servers.reduce((acc, s) => {
    if (s.gpuType) {
      const k = s.gpuType.name;
      acc[k] = (acc[k] ?? 0) + (s.gpuCount ?? 1);
    }
    return acc;
  }, {} as Record<string, number>);
  const gpuData = Object.entries(gpuFleet).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const downServers = servers.filter((s) => s.lastStatus === "down");
  const recentServers = [...servers].sort((a, b) => b.id - a.id).slice(0, 8);
  const displayServers = downServers.length > 0 ? downServers.slice(0, 6) : recentServers;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-up">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Infrastructure overview · auto-refreshes every 15s</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Servers"  value={total}      icon={Server}  color="bg-linear-to-br from-primary/20 to-primary/5"        delay={50} />
        <StatCard label="Online"         value={online}     icon={Wifi}    color="bg-linear-to-br from-emerald-500/25 to-emerald-500/5"  delay={100} sub={total > 0 ? `${uptimePct}% uptime` : undefined} />
        <StatCard label="Offline"        value={offline}    icon={WifiOff} color="bg-linear-to-br from-red-500/25 to-red-500/5"          delay={150} />
        <StatCard label="Cloud"          value={cloudCount} icon={Cloud}   color="bg-linear-to-br from-blue-400/20 to-blue-400/5"        delay={200} sub={avgLatency != null ? `avg ${avgLatency}ms` : undefined} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-xl shadow-xl p-5 animate-fade-up" style={{ animationDelay: "250ms" }}>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Environment Split</p>
          {envData.length > 0 ? (
            <div className="flex flex-col items-center">
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={envData} cx="50%" cy="50%" innerRadius={42} outerRadius={60} paddingAngle={4} dataKey="value">
                    {envData.map((e, i) => <Cell key={i} fill={e.color} stroke="transparent" />)}
                  </Pie>
                  <ReTooltip
                    contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "10px", fontSize: 12 }}
                    formatter={(v) => [`${v} servers`]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-1.5 w-full mt-1">
                {envData.map((e) => (
                  <div key={e.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: e.color }} />
                      <span className="text-muted-foreground">{e.name}</span>
                    </div>
                    <span className="font-semibold">{e.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-36 text-sm text-muted-foreground">No data yet</div>
          )}
        </div>

        <div className="col-span-1 md:col-span-2 rounded-xl border border-white/10 bg-card/60 backdrop-blur-xl shadow-xl p-5 animate-fade-up" style={{ animationDelay: "300ms" }}>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Cloud Providers</p>
          {providerData.length > 0 ? (
            <ResponsiveContainer width="100%" height={165}>
              <BarChart data={providerData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="oklch(1 0 0 / 0.06)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                <ReTooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "10px", fontSize: 12 }} />
                <Bar dataKey="count" fill="oklch(0.65 0.26 275)" radius={[6, 6, 0, 0]} maxBarSize={52} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-36 text-sm text-muted-foreground">No cloud servers</div>
          )}
        </div>
      </div>

      {/* Server list + side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="col-span-1 lg:col-span-2 rounded-xl border border-white/10 bg-card/60 backdrop-blur-xl shadow-xl p-5 animate-fade-up" style={{ animationDelay: "350ms" }}>
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {downServers.length > 0 ? `Offline Servers (${downServers.length})` : "Recent Servers"}
            </p>
            <Link to="/servers" className="text-xs text-primary hover:underline transition-colors">View all →</Link>
          </div>
          {displayServers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No servers yet. <Link to="/servers" className="text-primary hover:underline">Add one →</Link>
            </p>
          ) : (
            <>
              {displayServers.map((s) => <ServerRow key={s.id} server={s} />)}
              {downServers.length === 0 && (
                <p className="mt-3 text-xs text-emerald-400/70 flex items-center gap-1.5">
                  <Activity className="h-3 w-3" /> All monitored servers online
                </p>
              )}
            </>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-xl shadow-xl p-5 animate-fade-up" style={{ animationDelay: "400ms" }}>
            <div className="flex items-center gap-2 mb-4">
              <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">GPU Fleet</p>
            </div>
            {gpuData.length > 0 ? (
              <div className="space-y-2.5">
                {gpuData.map(([name, count]) => (
                  <div key={name} className="flex items-center justify-between gap-2">
                    <span className="text-sm truncate">{name}</span>
                    <span className="text-xs font-mono bg-white/8 px-2 py-0.5 rounded-full text-muted-foreground shrink-0">{count}×</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No GPU servers</p>
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-xl shadow-xl p-5 animate-fade-up" style={{ animationDelay: "450ms" }}>
            <div className="flex items-center gap-2 mb-4">
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quick Stats</p>
            </div>
            <div className="space-y-2.5">
              {[
                { label: "Uptime", value: `${uptimePct}%`, cls: "text-emerald-400" },
                { label: "Unknown", value: String(unknown), cls: "" },
                { label: "Avg latency", value: avgLatency != null ? `${avgLatency}ms` : "—", cls: "font-mono" },
                { label: "On-premise", value: String(total - cloudCount), cls: "" },
              ].map(({ label, value, cls }) => (
                <div key={label} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{label}</span>
                  <span className={`font-semibold ${cls}`}>{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
