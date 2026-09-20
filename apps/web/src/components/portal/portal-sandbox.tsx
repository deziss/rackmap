import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Server,
  Activity,
  Lock,
  Unlock,
  Users,
  Terminal,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  KeyRound,
  Trash2,
  ShieldCheck,
  Check,
} from "lucide-react";
import { toast } from "sonner";

interface PortalSandboxProps {
  onOpenCheckout: (plan: "free" | "pro" | "enterprise") => void;
}

export function PortalSandbox({ onOpenCheckout }: PortalSandboxProps) {
  const [activeConsoleTab, setActiveConsoleTab] = useState<"servers" | "atop" | "vault" | "users">("servers");
  const [selectedServer, setSelectedServer] = useState<number | null>(null);

  // ATOP Scrubber state
  const [timeSlider, setTimeSlider] = useState(14); // 14:00 UTC

  // Vault Demo state
  const [vaultPassword, setVaultPassword] = useState("p@ssw0rd!SuperSecret#2026");
  const [vaultUnlocked, setVaultUnlocked] = useState(false);

  // Users / Sudoers Demo state
  const [revokedOrphan, setRevokedOrphan] = useState(false);

  const mockServers = [
    {
      name: "prod-db-primary-01",
      ip: "10.0.4.12",
      os: "Ubuntu 22.04 LTS",
      kernel: "6.8.0-40-generic",
      service: "PostgreSQL 16.2 Core",
      cores: "16 vCPU",
      ram: "64 GB",
      disk: "2.4 TB NVMe",
      cpu: 24,
      ramUsage: 68,
      status: "Online",
      env: "Production",
      latency: "0.8ms",
    },
    {
      name: "api-cluster-worker-03",
      ip: "10.0.4.88",
      os: "Debian 12 Bookworm",
      kernel: "6.1.0-21-amd64",
      service: "Go Microservices + Node.js",
      cores: "8 vCPU",
      ram: "32 GB",
      disk: "500 GB SSD",
      cpu: 54,
      ramUsage: 48,
      status: "Online",
      env: "API Cluster",
      latency: "1.1ms",
    },
    {
      name: "k8s-ingress-gateway",
      ip: "192.168.10.15",
      os: "Rocky Linux 9.3",
      kernel: "5.14.0-362.el9",
      service: "Envoy Proxy + TLS Term",
      cores: "8 vCPU",
      ram: "16 GB",
      disk: "250 GB SSD",
      cpu: 18,
      ramUsage: 35,
      status: "Online",
      env: "Edge Router",
      latency: "0.4ms",
    },
    {
      name: "backup-storage-nas",
      ip: "192.168.20.5",
      os: "Ubuntu 24.04 LTS",
      kernel: "6.8.0-45-generic",
      service: "ZFS Pool (48 TB RAIDZ2)",
      cores: "4 vCPU",
      ram: "16 GB",
      disk: "48 TB ZFS",
      cpu: 8,
      ramUsage: 42,
      status: "Online",
      env: "Cold Storage",
      latency: "1.4ms",
    },
  ];

  const atopTimelineHours = [
    { hour: 0, cpu: 12 },
    { hour: 2, cpu: 8 },
    { hour: 4, cpu: 15 },
    { hour: 6, cpu: 22 },
    { hour: 8, cpu: 45 },
    { hour: 10, cpu: 62 },
    { hour: 12, cpu: 58 },
    { hour: 14, cpu: 98, spike: true },
    { hour: 16, cpu: 74 },
    { hour: 18, cpu: 48 },
    { hour: 20, cpu: 38 },
    { hour: 22, cpu: 26 },
  ];

  const currentAtopData =
    timeSlider === 14
      ? {
          timestamp: "14:22:10 UTC",
          topProc: "postgres: worker [analytics_rollup]",
          pid: 9482,
          cpu: "98.2%",
          mem: "14.2 GB",
          io: "184 MB/s (Write)",
          status: "CRITICAL KERNEL BOTTLENECK",
          diagnosis: "High IO wait (iowait=78%). Sequential scan on 84M row unindexed table causing disk saturation.",
        }
      : timeSlider < 8
      ? {
          timestamp: `${String(timeSlider).padStart(2, "0")}:15:00 UTC`,
          topProc: "dockerd --default-runtime",
          pid: 389,
          cpu: "4.8%",
          mem: "2.1 GB",
          io: "1.2 MB/s (Read)",
          status: "NORMAL OPERATING STATE",
          diagnosis: "Nightly idle baseline. Target node operating within normal CPU and memory thresholds.",
        }
      : {
          timestamp: `${String(timeSlider).padStart(2, "0")}:30:20 UTC`,
          topProc: "node /app/dist/main.js",
          pid: 1204,
          cpu: "42.5%",
          mem: "3.4 GB",
          io: "14.8 MB/s (Write)",
          status: "MODERATE TRAFFIC ELEVATION",
          diagnosis: "Standard peak business hour load. Worker pool healthy, zero kernel thrashing.",
        };

  return (
    <div id="demo" className="mt-16 scroll-mt-24">
      <div className="rounded-2xl border border-white/15 bg-slate-900/90 shadow-2xl shadow-blue-950/60 backdrop-blur-2xl overflow-hidden">
        {/* Window Frame Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full bg-[#FF5F56] inline-block shadow-sm" />
              <span className="h-3 w-3 rounded-full bg-[#FFBD2E] inline-block shadow-sm" />
              <span className="h-3 w-3 rounded-full bg-[#27C93F] inline-block shadow-sm" />
            </div>
            <div className="flex items-center gap-2 pl-2 border-l border-white/10 font-mono text-xs text-slate-400">
              <Terminal className="h-3.5 w-3.5 text-blue-400" />
              <span>rackmap://fleet-sandbox.internal:3123/live-telemetry</span>
            </div>
          </div>

          {/* Tab Switcher */}
          <div className="flex items-center gap-1 rounded-xl bg-slate-950 p-1 border border-white/10 text-xs font-medium">
            <button
              type="button"
              onClick={() => setActiveConsoleTab("servers")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all cursor-pointer ${
                activeConsoleTab === "servers"
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Server className="h-3.5 w-3.5" />
              Live Fleet Matrix
            </button>
            <button
              type="button"
              onClick={() => setActiveConsoleTab("atop")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all cursor-pointer ${
                activeConsoleTab === "atop"
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              ATOP Replay (Pro)
            </button>
            <button
              type="button"
              onClick={() => setActiveConsoleTab("vault")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all cursor-pointer ${
                activeConsoleTab === "vault"
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Lock className="h-3.5 w-3.5" />
              Credential Vault
            </button>
            <button
              type="button"
              onClick={() => setActiveConsoleTab("users")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all cursor-pointer ${
                activeConsoleTab === "users"
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Remote Sudoers (Pro)
            </button>
          </div>
        </div>

        {/* Tab 1: Live Fleet Matrix */}
        {activeConsoleTab === "servers" && (
          <div className="p-4 sm:p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-950/60 p-3 rounded-xl border border-white/5">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                </span>
                <span className="text-xs font-semibold text-white">4 Monitored Target Nodes</span>
                <span className="text-slate-500">•</span>
                <span className="text-xs font-mono text-slate-400">Polling Interval: 60s (Agentless SSH)</span>
              </div>
              <Button
                size="sm"
                onClick={() => onOpenCheckout("pro")}
                className="h-8 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 text-xs gap-1.5 rounded-lg cursor-pointer"
              >
                <Sparkles className="h-3.5 w-3.5 text-blue-400" />
                Manage up to 100 with Pro
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {mockServers.map((srv, idx) => (
                <div
                  key={idx}
                  onClick={() => setSelectedServer(selectedServer === idx ? null : idx)}
                  className={`rounded-xl border p-4 transition-all duration-200 cursor-pointer ${
                    selectedServer === idx
                      ? "border-blue-500 bg-slate-950 shadow-lg shadow-blue-500/20 ring-1 ring-blue-500"
                      : "border-white/10 bg-slate-950/70 hover:border-blue-500/40 hover:bg-slate-950/90"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                      ONLINE • {srv.latency}
                    </Badge>
                    <span className="text-[10px] font-mono text-slate-400">{srv.env}</span>
                  </div>

                  <h4 className="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors truncate">
                    {srv.name}
                  </h4>
                  <p className="text-xs font-mono text-slate-400 mt-0.5">{srv.ip}</p>
                  <p className="text-[11px] text-blue-400 font-medium mt-1 truncate">{srv.service}</p>

                  <div className="mt-4 space-y-2 text-xs">
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                        <span>CPU Load</span>
                        <span className="font-mono text-slate-200">{srv.cpu}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${srv.cpu}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                        <span>Memory</span>
                        <span className="font-mono text-slate-200">{srv.ramUsage}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${srv.ramUsage}%` }} />
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">{srv.cores} • {srv.ram}</span>
                    <span className="inline-flex items-center gap-1 text-cyan-400 font-mono">
                      <Activity className="h-3 w-3" />
                      ATOP OK
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Selected Node Inspector Drawer */}
            {selectedServer !== null && (
              <div className="p-4 rounded-xl border border-blue-500/30 bg-slate-950/90 space-y-3 animate-fade-in">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-blue-400" />
                    <span className="font-mono text-xs font-bold text-white">
                      Target Node Inspection: {mockServers[selectedServer].name} ({mockServers[selectedServer].ip})
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedServer(null)}
                    className="h-6 text-xs text-slate-400 hover:text-white"
                  >
                    Close Inspector
                  </Button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  <div className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                    <span className="text-slate-400 text-[10px] block">OS &amp; KERNEL</span>
                    <span className="text-white font-semibold">{mockServers[selectedServer].os}</span>
                    <span className="text-slate-400 text-[10px] block">{mockServers[selectedServer].kernel}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                    <span className="text-slate-400 text-[10px] block">COMPUTE &amp; RAM</span>
                    <span className="text-white font-semibold">{mockServers[selectedServer].cores}</span>
                    <span className="text-slate-400 text-[10px] block">{mockServers[selectedServer].ram} DDR4</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                    <span className="text-slate-400 text-[10px] block">STORAGE SUBSYSTEM</span>
                    <span className="text-white font-semibold">{mockServers[selectedServer].disk}</span>
                    <span className="text-emerald-400 text-[10px] block">Health: PASSED (SMART)</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                    <span className="text-slate-400 text-[10px] block">SECURITY CREDENTIAL</span>
                    <span className="text-white font-semibold">AES-256-GCM</span>
                    <span className="text-emerald-400 text-[10px] block">Key ID: #vlt-482a</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: ATOP Replay */}
        {activeConsoleTab === "atop" && (
          <div className="p-4 sm:p-6 space-y-5">
            <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-blue-300 flex items-center gap-2">
                  <Activity className="h-4 w-4" />
                  ATOP Historical Time-Machine Replay
                </h4>
                <p className="text-xs text-slate-300 mt-1">
                  High-resolution kernel telemetry logged to <code className="text-cyan-400 font-mono">/var/log/atop/atop_20260918</code> via agentless SFTP sync.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-white bg-slate-950 px-2.5 py-1 rounded-md border border-white/10">
                  {currentAtopData.timestamp}
                </span>
                <Badge className="bg-blue-600 text-white border-0 text-[10px]">
                  Pro Feature
                </Badge>
              </div>
            </div>

            {/* Visual 24-Hour Bar Chart */}
            <div className="p-4 rounded-xl bg-slate-950 border border-white/10 space-y-3">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">24-Hour Kernel CPU Activity (10-Second ATOP Log Interval)</span>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-slate-400">
                    <span className="h-2 w-2 rounded-full bg-blue-500" /> Normal (&lt;70%)
                  </span>
                  <span className="flex items-center gap-1 text-red-400">
                    <span className="h-2 w-2 rounded-full bg-red-500" /> Spike (&gt;90%)
                  </span>
                </div>
              </div>

              {/* Chart Bars */}
              <div className="h-24 flex items-end justify-between gap-1.5 pt-4">
                {atopTimelineHours.map((item, i) => {
                  const isSelected = item.hour === timeSlider;
                  return (
                    <div
                      key={i}
                      onClick={() => setTimeSlider(item.hour)}
                      className="flex-1 flex flex-col items-center gap-1 group cursor-pointer"
                    >
                      <div
                        className={`w-full rounded-t transition-all duration-200 ${
                          item.spike
                            ? isSelected
                              ? "bg-red-400 shadow-md shadow-red-500/50"
                              : "bg-red-500/70 hover:bg-red-500"
                            : isSelected
                            ? "bg-blue-400 shadow-md shadow-blue-500/50"
                            : "bg-blue-600/50 hover:bg-blue-500"
                        }`}
                        style={{ height: `${item.cpu}%` }}
                      />
                      <span className={`text-[10px] font-mono ${isSelected ? "text-white font-bold" : "text-slate-500"}`}>
                        {String(item.hour).padStart(2, "0")}h
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Slider & Presets */}
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-white/5">
                <div className="w-full sm:w-1/2 flex items-center gap-3">
                  <span className="text-[11px] font-mono text-slate-400 shrink-0">Scrub Hour:</span>
                  <input
                    type="range"
                    min="0"
                    max="23"
                    value={timeSlider}
                    onChange={(e) => setTimeSlider(Number(e.target.value))}
                    className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-400 text-[11px] mr-1">Presets:</span>
                  <button
                    type="button"
                    onClick={() => setTimeSlider(4)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono cursor-pointer transition-all ${timeSlider === 4 ? "bg-blue-600 text-white" : "bg-white/5 text-slate-300 hover:text-white"}`}
                  >
                    04:00 (Idle)
                  </button>
                  <button
                    type="button"
                    onClick={() => setTimeSlider(10)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono cursor-pointer transition-all ${timeSlider === 10 ? "bg-blue-600 text-white" : "bg-white/5 text-slate-300 hover:text-white"}`}
                  >
                    10:00 (Load)
                  </button>
                  <button
                    type="button"
                    onClick={() => setTimeSlider(14)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono cursor-pointer transition-all ${timeSlider === 14 ? "bg-red-600 text-white font-bold" : "bg-red-500/20 text-red-300 hover:bg-red-500/30"}`}
                  >
                    14:00 (Crash Spike)
                  </button>
                </div>
              </div>
            </div>

            {/* Forensic Diagnosis Box */}
            <div className={`p-4 rounded-xl border text-xs font-mono space-y-2 ${timeSlider === 14 ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-white/10 bg-slate-950 text-slate-300"}`}>
              <div className="flex items-center justify-between">
                <span className="font-bold flex items-center gap-1.5">
                  {timeSlider === 14 ? <AlertTriangle className="h-4 w-4 text-red-400" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
                  {currentAtopData.status}
                </span>
                <span className="text-[11px] font-bold">PID {currentAtopData.pid} • {currentAtopData.topProc}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-300">
                {currentAtopData.diagnosis}
              </p>
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/5 text-[11px]">
                <div>CPU Consumption: <span className="font-bold text-white">{currentAtopData.cpu}</span></div>
                <div>Memory Virtual: <span className="font-bold text-white">{currentAtopData.mem}</span></div>
                <div>Disk IO Rate: <span className="font-bold text-white">{currentAtopData.io}</span></div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Credential Vault */}
        {activeConsoleTab === "vault" && (
          <div className="p-4 sm:p-6 space-y-5">
            <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-indigo-300 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                  AES-256-GCM Envelope Encryption (PBKDF2 → KEK → DEK)
                </h4>
                <p className="text-xs text-slate-300 mt-1">
                  The master passphrase is never stored in the database — only a salt and a verifier. The unwrapped key lives in server memory for the duration of an unlocked session and is never written to disk or logged.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => setVaultUnlocked(!vaultUnlocked)}
                className={`text-xs gap-1.5 cursor-pointer ${vaultUnlocked ? "bg-amber-600 hover:bg-amber-500 text-white" : "bg-indigo-600 hover:bg-indigo-500 text-white"}`}
              >
                {vaultUnlocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                {vaultUnlocked ? "Lock Secret with Master Key" : "Simulate Master Key Unlock"}
              </Button>
            </div>

            {/* Interactive Secret Input Simulator */}
            <div className="p-4 rounded-xl bg-slate-950 border border-white/10 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="text-xs font-mono text-slate-300">
                  Type a Sample Root Password or SSH Private Key:
                </label>
                <span className="text-[11px] text-emerald-400 font-mono flex items-center gap-1">
                  <Check className="h-3 w-3" /> Passphrase Never Persisted to the Database
                </span>
              </div>

              <input
                type="text"
                value={vaultPassword}
                onChange={(e) => setVaultPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-slate-900 border border-white/10 text-white font-mono text-xs focus:outline-none focus:border-blue-500"
              />

              {/* Comparison Panels */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div className="p-4 rounded-xl border border-white/10 bg-slate-900/80 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">What the API &amp; Database Stores</span>
                    <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">Opaque Ciphertext</Badge>
                  </div>
                  <pre className="text-xs font-mono text-slate-400 bg-slate-950 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all border border-white/5">
                    {`"ciphertext": "aes-256-gcm:iv:8a9b7c6d5e4f:tag:4d3c2b1a:${btoa(vaultPassword).slice(0, 32)}9f8a7b..."
"salt": "d04a621ef8839cb80172e81..."
"iterations": 100000`}
                  </pre>
                </div>

                <div className="p-4 rounded-xl border border-white/10 bg-slate-900/80 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">In-Browser Memory State</span>
                    <Badge variant="outline" className={`text-[10px] ${vaultUnlocked ? "text-emerald-400 border-emerald-500/30" : "text-slate-500"}`}>
                      {vaultUnlocked ? "Unlocked / Decrypted" : "Locked / Ciphertext"}
                    </Badge>
                  </div>
                  <div className="rounded-lg bg-slate-950 p-3 border border-white/5 font-mono text-xs flex items-center justify-between">
                    {vaultUnlocked ? (
                      <span className="text-emerald-300 font-bold">{vaultPassword}</span>
                    ) : (
                      <span className="text-slate-500">••••••••••••••••••••••••••••••••</span>
                    )}
                    <KeyRound className={`h-4 w-4 ${vaultUnlocked ? "text-emerald-400" : "text-slate-600"}`} />
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Even with complete root SQL access, database dumps expose only ciphertext — never cleartext passwords.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: Remote Sudoers */}
        {activeConsoleTab === "users" && (
          <div className="p-4 sm:p-6 space-y-5">
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-sky-300 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Remote OS Users &amp; Sudo Privilege Auditing
                </h4>
                <p className="text-xs text-slate-300 mt-1">
                  Audited continuously via agentless SSH from <code className="text-cyan-400 font-mono">/etc/passwd</code>, <code className="text-cyan-400 font-mono">/etc/sudoers.d/</code>, and authorized keys.
                </p>
              </div>
              <Badge className="bg-sky-600 text-white border-0 text-[10px]">
                Pro Feature
              </Badge>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* User 1 */}
                <div className="rounded-xl border border-white/10 bg-slate-950 p-4 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-red-400">root (UID 0)</span>
                    <Badge className="text-[10px] bg-red-500/20 text-red-300 border-red-500/30">Full Superuser</Badge>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono space-y-1">
                    <p>Shell: <span className="text-slate-200">/bin/bash</span></p>
                    <p>Sudo: <span className="text-amber-300">ALL=(ALL:ALL) ALL</span></p>
                    <p>SSH Keys: <span className="text-emerald-400">1 Authorized Key</span></p>
                  </div>
                </div>

                {/* User 2 */}
                <div className="rounded-xl border border-white/10 bg-slate-950 p-4 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-amber-400">ansible-deploy (UID 1001)</span>
                    <Badge className="text-[10px] bg-amber-500/20 text-amber-300 border-amber-500/30">Automation Bot</Badge>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono space-y-1">
                    <p>Shell: <span className="text-slate-200">/bin/bash</span></p>
                    <p>Sudo: <span className="text-amber-300">NOPASSWD: ALL</span></p>
                    <p>SSH Keys: <span className="text-emerald-400">2 Authorized Keys</span></p>
                  </div>
                </div>

                {/* User 3 (Orphan Drift) */}
                <div className={`rounded-xl border p-4 text-xs space-y-2 transition-all duration-300 ${revokedOrphan ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/50 bg-red-500/10"}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-red-300">orphan-contractor (UID 1042)</span>
                    <Badge className={revokedOrphan ? "text-[10px] bg-emerald-500/20 text-emerald-300" : "text-[10px] bg-red-600 text-white font-bold"}>
                      {revokedOrphan ? "Revoked & Purged" : "UNAUTHORIZED DRIFT"}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-slate-300 font-mono space-y-1">
                    <p>Shell: <span className={revokedOrphan ? "line-through text-slate-500" : "text-slate-200"}>/bin/bash</span></p>
                    <p>Sudo: <span className={revokedOrphan ? "line-through text-slate-500" : "text-red-300 font-bold"}>NOPASSWD: ALL</span></p>
                    <p>SSH Keys: <span className={revokedOrphan ? "text-slate-500 line-through" : "text-red-300"}>1 Stale Authorized Key</span></p>
                  </div>
                  <div className="pt-2 border-t border-white/10 flex items-center justify-between">
                    <span className="text-[10px] text-slate-400">
                      {revokedOrphan ? "Compliance verified" : "Alert: Contract expired 14d ago"}
                    </span>
                    <Button
                      size="sm"
                      variant={revokedOrphan ? "outline" : "destructive"}
                      onClick={() => {
                        setRevokedOrphan(!revokedOrphan);
                        toast.success(revokedOrphan ? "Restored test account" : "Simulated SSH revocation of /etc/sudoers.d/orphan-contractor!");
                      }}
                      className="h-6 text-[10px] px-2 cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3 mr-1" />
                      {revokedOrphan ? "Undo Simulation" : "Simulate Revoke Drift"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
