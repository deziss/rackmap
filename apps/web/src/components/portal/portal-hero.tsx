import { Button } from "@/components/ui/button";
import { Sparkles, ArrowRight, Activity, CheckCircle2 } from "lucide-react";

interface PortalHeroProps {
  onOpenCheckout: (plan: "free" | "pro" | "enterprise") => void;
}

export function PortalHero({ onOpenCheckout }: PortalHeroProps) {
  return (
    <section className="relative pt-32 pb-20 sm:pt-40 sm:pb-28">
      <div className="container mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col items-center text-center">
          {/* Live Beacon Announcement Pill */}
          <div className="inline-flex items-center gap-2.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-4 py-1.5 text-xs font-medium text-blue-300 shadow-lg shadow-blue-950/40 backdrop-blur-md mb-8">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="font-mono text-[11px] uppercase tracking-wider text-blue-300">
              LICENCIA SYSTEM ONLINE
            </span>
            <span className="text-blue-400/40">•</span>
            <span className="text-slate-300 text-[11px]">Free Community (10 Nodes) &amp; Pro / Enterprise Tiers</span>
          </div>

          {/* Main Headline */}
          <h1 className="max-w-4xl text-4xl font-extrabold tracking-tight text-white sm:text-6xl sm:leading-[1.12]">
            Total Linux Fleet Visibility.{" "}
            <span className="bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent">
              Zero Target Overhead.
            </span>
          </h1>

          {/* Subtitle */}
          <p className="mt-6 max-w-2xl text-base sm:text-lg text-slate-400 leading-relaxed">
            Discover bare-metal &amp; cloud topology, replay second-by-second ATOP kernel bottlenecks, audit remote sudoers, and safeguard root credentials with an AES-256-GCM encrypted vault. Pure agentless SSH.
          </p>

          {/* Hero CTAs */}
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
            <Button
              size="lg"
              onClick={() => onOpenCheckout("pro")}
              className="h-12 px-7 bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500 hover:from-blue-500 hover:to-indigo-500 text-white shadow-xl shadow-blue-600/35 gap-2 font-semibold text-sm rounded-xl cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <Sparkles className="h-4 w-4 text-blue-200" />
              Upgrade to Pro via Licencia
              <ArrowRight className="h-4 w-4" />
            </Button>

            <Button
              size="lg"
              variant="outline"
              onClick={() => onOpenCheckout("free")}
              className="h-12 px-6 border-white/15 bg-white/5 hover:bg-white/10 text-white font-medium backdrop-blur-md text-sm rounded-xl cursor-pointer transition-all"
            >
              Claim Free Community Plan
            </Button>

            <a href="#demo">
              <Button size="lg" variant="ghost" className="h-12 px-5 text-slate-300 hover:text-white hover:bg-white/5 gap-2 text-sm rounded-xl cursor-pointer transition-all">
                <Activity className="h-4 w-4 text-cyan-400" />
                Live Sandbox ↓
              </Button>
            </a>
          </div>

          {/* Trust Highlights */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-6 sm:gap-8 text-xs text-slate-400 font-medium">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>100% Agentless SSH</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>AES-256-GCM Vault</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>Kernel ATOP Time-Machine</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>Air-Gapped Ed25519 Licencia Tokens</span>
            </div>
          </div>

          {/* Metric Counters Banner */}
          <div className="mt-12 w-full max-w-4xl grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 rounded-2xl border border-white/10 bg-slate-900/50 backdrop-blur-xl">
            <div className="p-3 text-center border-r border-white/5 last:border-0">
              <span className="block text-2xl font-mono font-extrabold text-white">0 MB</span>
              <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">Daemon Memory</span>
            </div>
            <div className="p-3 text-center border-r border-white/5 last:border-0">
              <span className="block text-2xl font-mono font-extrabold text-blue-400">&lt; 100ms</span>
              <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">SSH Telemetry</span>
            </div>
            <div className="p-3 text-center border-r border-white/5 last:border-0">
              <span className="block text-2xl font-mono font-extrabold text-emerald-400">256-Bit</span>
              <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">Encrypted Vault</span>
            </div>
            <div className="p-3 text-center">
              <span className="block text-2xl font-mono font-extrabold text-purple-400">Ed25519</span>
              <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">Offline Lease</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
