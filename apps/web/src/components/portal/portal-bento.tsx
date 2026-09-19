import { Badge } from "@/components/ui/badge";
import {
  Terminal,
  ShieldCheck,
  Users,
  Activity,
  Zap,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Server,
  Layers,
} from "lucide-react";

export function PortalBento() {
  return (
    <>
      {/* ================= ASYMMETRIC BENTO GRID ================= */}
      <section id="features" className="py-24 border-t border-white/10 bg-slate-950/70 relative">
        <div className="container mx-auto max-w-6xl px-4 sm:px-6">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3.5 py-1 mb-3">
              Technical Architecture
            </Badge>
            <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">
              Enterprise Linux Telemetry Without The SaaS Agent Tax
            </h2>
            <p className="mt-4 text-sm sm:text-base text-slate-400 leading-relaxed">
              Traditional monitoring platforms burden production nodes with heavy daemons, open root ports, and unencrypted cleartext passwords. RackMap replaces all three with zero-footprint SSH and WebCrypto encryption.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Bento Card 1: Agentless Engine (Spans 2 cols) */}
            <div className="md:col-span-2 rounded-2xl border border-white/10 bg-slate-900/60 p-7 hover:border-blue-500/40 hover:bg-slate-900/80 transition-all duration-300 group flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="h-12 w-12 rounded-xl bg-sky-500/10 flex items-center justify-center text-sky-400 group-hover:scale-105 transition-transform">
                    <Terminal className="h-6 w-6" />
                  </div>
                  <Badge variant="outline" className="text-sky-400 border-sky-500/30 text-[11px] font-mono">
                    100% Agentless
                  </Badge>
                </div>
                <h3 className="text-xl font-bold text-white mb-2">
                  Native Linux Kernel Utilities Over Ephemeral SSH
                </h3>
                <p className="text-sm text-slate-400 leading-relaxed max-w-xl">
                  Zero daemons to compile, update, or patch. Collects CPU, memory, NVMe SMART wear, network sockets, and hardware specs using standard Linux utilities (<code className="text-sky-400">lshw</code>, <code className="text-sky-400">dmidecode</code>, <code className="text-sky-400">atop</code>, <code className="text-sky-400">ss</code>, <code className="text-sky-400">ip</code>).
                </p>
              </div>

              <div className="mt-6 p-4 rounded-xl bg-slate-950 border border-white/5 font-mono text-xs text-slate-300 space-y-1">
                <div className="text-slate-500"># Ephemeral SSH session execution</div>
                <div><span className="text-blue-400">$</span> ssh -i id_ed25519 root@10.0.4.12 &quot;atop 1 1 -M &amp;&amp; lshw -json&quot;</div>
                <div className="text-emerald-400">✔ Completed in 84ms • Exit Code: 0 • Target Memory Overhead: 0 MB</div>
              </div>
            </div>

            {/* Bento Card 2: Zero Knowledge Vault (Spans 1 col) */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-7 hover:border-emerald-500/40 hover:bg-slate-900/80 transition-all duration-300 group flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="h-12 w-12 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-400 group-hover:scale-105 transition-transform">
                    <ShieldCheck className="h-6 w-6" />
                  </div>
                  <Badge variant="outline" className="text-emerald-400 border-emerald-500/30 text-[11px] font-mono">
                    WebCrypto API
                  </Badge>
                </div>
                <h3 className="text-lg font-bold text-white mb-2">
                  Client-Side Zero-Knowledge Vault
                </h3>
                <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
                  Passwords and SSH private keys are encrypted directly in the client browser with AES-256-GCM. The API and database only store ciphertext.
                </p>
              </div>
              <div className="mt-6 pt-4 border-t border-white/5 flex items-center gap-2 text-xs text-emerald-400 font-mono">
                <CheckCircle2 className="h-4 w-4" />
                <span>Zero Cleartext in Database Dumps</span>
              </div>
            </div>

            {/* Bento Card 3: Sudo Privilege Auditing (Spans 1 col) */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-7 hover:border-amber-500/40 hover:bg-slate-900/80 transition-all duration-300 group flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="h-12 w-12 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-400 group-hover:scale-105 transition-transform">
                    <Users className="h-6 w-6" />
                  </div>
                  <Badge variant="outline" className="text-amber-400 border-amber-500/30 text-[11px] font-mono">
                    Shadow Accounts
                  </Badge>
                </div>
                <h3 className="text-lg font-bold text-white mb-2">
                  Remote Sudo &amp; User Drift Auditing
                </h3>
                <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
                  Detect backdoor users, unauthorized NOPASSWD entries in <code className="text-amber-400">/etc/sudoers.d/</code>, and stale SSH authorized keys across your cluster.
                </p>
              </div>
              <div className="mt-6 pt-4 border-t border-white/5 flex items-center gap-2 text-xs text-amber-400 font-mono">
                <AlertTriangle className="h-4 w-4" />
                <span>Instant Sudo Drift Detection</span>
              </div>
            </div>

            {/* Bento Card 4: ATOP Kernel Time-Machine (Spans 2 cols) */}
            <div className="md:col-span-2 rounded-2xl border border-white/10 bg-slate-900/60 p-7 hover:border-blue-500/40 hover:bg-slate-900/80 transition-all duration-300 group flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="h-12 w-12 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-400 group-hover:scale-105 transition-transform">
                    <Activity className="h-6 w-6" />
                  </div>
                  <Badge variant="outline" className="text-blue-400 border-blue-500/30 text-[11px] font-mono">
                    Second-by-Second
                  </Badge>
                </div>
                <h3 className="text-xl font-bold text-white mb-2">
                  Kernel ATOP Historical Time-Machine
                </h3>
                <p className="text-sm text-slate-400 leading-relaxed max-w-xl">
                  Replay historical performance crashes second-by-second. Scrub to the exact minute of a kernel panic, memory leak, or disk IO stall to inspect active processes and offending PIDs.
                </p>
              </div>

              <div className="mt-6 grid grid-cols-3 gap-3 text-center text-xs font-mono">
                <div className="p-3 rounded-lg bg-slate-950 border border-white/5">
                  <span className="text-blue-400 font-bold block text-sm">30 Days</span>
                  <span className="text-slate-500 text-[10px]">Pro Retention</span>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-white/5">
                  <span className="text-indigo-400 font-bold block text-sm">365 Days</span>
                  <span className="text-slate-500 text-[10px]">Enterprise Retention</span>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-white/5">
                  <span className="text-emerald-400 font-bold block text-sm">10-Second</span>
                  <span className="text-slate-500 text-[10px]">Sample Resolution</span>
                </div>
              </div>
            </div>

            {/* Bento Card 5: Licencia Offline Gating (Spans 1 col) */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-7 hover:border-purple-500/40 hover:bg-slate-900/80 transition-all duration-300 group flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="h-12 w-12 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-400 group-hover:scale-105 transition-transform">
                    <Zap className="h-6 w-6" />
                  </div>
                  <Badge variant="outline" className="text-purple-400 border-purple-500/30 text-[11px] font-mono">
                    Air-Gapped
                  </Badge>
                </div>
                <h3 className="text-lg font-bold text-white mb-2">
                  Licencia Dual-Mode Cryptographic Gating
                </h3>
                <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
                  Seamlessly upgrades from Community to Enterprise. Supports offline Ed25519 digital signature validation for isolated, air-gapped networks.
                </p>
              </div>
              <div className="mt-6 pt-4 border-t border-white/5 flex items-center gap-2 text-xs text-purple-400 font-mono">
                <CheckCircle2 className="h-4 w-4" />
                <span>Zero Internet Connection Needed</span>
              </div>
            </div>

            {/* Bento Card 6: Fleet Telemetry & Exports (Spans 2 cols) */}
            <div className="md:col-span-2 rounded-2xl border border-white/10 bg-slate-900/60 p-7 hover:border-blue-500/40 hover:bg-slate-900/80 transition-all duration-300 group flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="h-12 w-12 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-400 group-hover:scale-105 transition-transform">
                    <FileSpreadsheet className="h-6 w-6" />
                  </div>
                  <Badge variant="outline" className="text-blue-400 border-blue-500/30 text-[11px] font-mono">
                    Compliance
                  </Badge>
                </div>
                <h3 className="text-xl font-bold text-white mb-2">
                  Comprehensive Fleet Analytics &amp; 1-Click Audit Exports
                </h3>
                <p className="text-sm text-slate-400 leading-relaxed max-w-xl">
                  Generate executive-ready PDF &amp; Excel sheets covering your entire physical hardware inventory, memory distributions, OS version fragmentation, and upcoming SSL certificate renewals.
                </p>
              </div>

              <div className="mt-6 flex flex-wrap gap-2 text-xs font-mono">
                <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-slate-300">
                  PDF Executive Summaries
                </span>
                <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-slate-300">
                  Excel Hardware Matrix
                </span>
                <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-slate-300">
                  Prometheus Exporter
                </span>
                <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-slate-300">
                  Slack / Discord Webhooks
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================= ARCHITECTURAL FLOW PIPELINE ================= */}
      <section id="architecture" className="py-24 border-t border-white/10 bg-slate-950 relative">
        <div className="container mx-auto max-w-6xl px-4 sm:px-6">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3.5 py-1 mb-3">
              Zero-Trust Architecture
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              How Telemetry Flows Without Cleartext Exposure
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 relative">
            {[
              {
                step: "01",
                title: "Target Linux Nodes",
                desc: "Bare-metal or cloud instances running standard Linux (Ubuntu, Debian, RHEL, Rocky). Zero background daemons installed.",
                icon: Server,
              },
              {
                step: "02",
                title: "Ephemeral SSH Tunnel",
                desc: "RackMap initiates short-lived SSH connections over Port 22 using public keys, executing native commands and closing immediately.",
                icon: Terminal,
              },
              {
                step: "03",
                title: "Self-Hosted API Core",
                desc: "Stores parsed hardware specs and encrypted ciphertext. Interacts with Licencia to enforce tier-based node limits.",
                icon: Layers,
              },
              {
                step: "04",
                title: "Browser WebCrypto",
                desc: "Decryption happens exclusively on the client device using browser WebCrypto AES-256-GCM. Plaintext never traverses the wire.",
                icon: ShieldCheck,
              },
            ].map((p, idx) => {
              const Icon = p.icon;
              return (
                <div key={idx} className="p-6 rounded-2xl border border-white/10 bg-slate-900/60 relative space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-2xl font-mono font-black text-blue-500/40">{p.step}</span>
                    <Icon className="h-5 w-5 text-blue-400" />
                  </div>
                  <h4 className="text-base font-bold text-white">{p.title}</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">{p.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}
