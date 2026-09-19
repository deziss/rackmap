import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { CloudCog, Sparkles, ArrowRight } from "lucide-react";

interface PortalFooterProps {
  onOpenCheckout: (plan: "free" | "pro" | "enterprise") => void;
}

export function PortalFooter({ onOpenCheckout }: PortalFooterProps) {
  return (
    <>
      {/* ================= FINAL CTA BANNER ================= */}
      <section className="py-24 border-t border-white/10 bg-gradient-to-b from-slate-950 via-blue-950/30 to-slate-950 relative overflow-hidden">
        <div className="container mx-auto max-w-5xl px-4 sm:px-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3.5 py-1 text-xs font-semibold text-blue-300 mb-6">
            <Sparkles className="h-3.5 w-3.5" />
            Instant Digital Fulfillment &amp; 1-Click Activation
          </div>

          <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">
            Ready to Take Full Control of Your Linux Servers?
          </h2>
          <p className="mt-4 text-sm sm:text-base text-slate-300 max-w-2xl mx-auto leading-relaxed">
            Manage your servers with zero agent overhead, kernel-level forensic telemetry, and total zero-knowledge cryptographic privacy.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
            <Button
              size="lg"
              onClick={() => onOpenCheckout("pro")}
              className="h-12 px-8 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-xl shadow-blue-600/40 font-semibold text-sm rounded-xl gap-2 cursor-pointer transition-all"
            >
              <Sparkles className="h-4 w-4" />
              Upgrade to Pro Plan
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Link to="/servers">
              <Button size="lg" variant="outline" className="h-12 px-8 border-white/15 text-white hover:bg-white/10 text-sm rounded-xl cursor-pointer">
                Open Server Inventory
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ================= FOOTER ================= */}
      <footer className="border-t border-white/10 bg-slate-950 py-14 text-xs text-slate-400">
        <div className="container mx-auto max-w-6xl px-4 sm:px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md shadow-blue-600/30">
              <CloudCog className="h-4.5 w-4.5" />
            </div>
            <div>
              <span className="font-bold text-white text-sm">RackMap</span>
              <p className="text-[11px] text-slate-400">Agentless Linux Server Inventory &amp; Zero-Knowledge Vault</p>
            </div>
          </div>

          <div className="flex items-center gap-6 font-medium">
            <a href="#features" className="hover:text-white transition-colors cursor-pointer">Features</a>
            <a href="#architecture" className="hover:text-white transition-colors cursor-pointer">Architecture</a>
            <a href="#pricing" className="hover:text-white transition-colors cursor-pointer">Pricing</a>
            <Link to="/login" className="hover:text-white transition-colors cursor-pointer">Console Login</Link>
            <Link to="/servers" className="hover:text-white transition-colors cursor-pointer">Servers</Link>
          </div>

          <div className="flex items-center gap-2.5 text-slate-400 font-mono text-[11px] bg-white/5 border border-white/5 px-3 py-1.5 rounded-full">
            <span className="h-2 w-2 rounded-full bg-emerald-400 inline-block animate-pulse" />
            <span>Licencia v1.4.2 Connected</span>
          </div>
        </div>
      </footer>
    </>
  );
}
