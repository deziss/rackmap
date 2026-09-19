import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { CloudCog, Sparkles, ArrowRight } from "lucide-react";

interface PortalNavProps {
  isAuthenticated: boolean;
  userName?: string;
  onOpenCheckout: (plan: "free" | "pro" | "enterprise") => void;
}

export function PortalNav({ isAuthenticated, userName, onOpenCheckout }: PortalNavProps) {
  return (
    <header className="fixed top-4 left-4 right-4 sm:left-6 sm:right-6 max-w-6xl mx-auto z-50 transition-all">
      <div className="flex h-14 items-center justify-between rounded-full border border-white/10 bg-slate-950/85 px-4 sm:px-6 backdrop-blur-2xl shadow-2xl shadow-black/60">
        {/* Brand Logo */}
        <div className="flex items-center gap-3">
          <Link to="/portal" className="flex items-center gap-2.5 group cursor-pointer">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-500 text-white shadow-md shadow-blue-500/30 transition-transform duration-200 group-hover:scale-105">
              <CloudCog className="h-4.5 w-4.5" />
            </div>
            <span className="text-base font-extrabold tracking-tight text-white flex items-center gap-2">
              RackMap
              <span className="rounded-full bg-blue-500/15 border border-blue-500/30 px-2 py-0.5 text-[10px] font-mono font-semibold text-blue-400">
                PORTAL
              </span>
            </span>
          </Link>
        </div>

        {/* Navigation Anchors */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-300">
          <a href="#features" className="transition-colors hover:text-white cursor-pointer">Features</a>
          <a href="#demo" className="transition-colors hover:text-white cursor-pointer">Live Sandbox</a>
          <a href="#architecture" className="transition-colors hover:text-white cursor-pointer">Architecture</a>
          <a href="#pricing" className="transition-colors hover:text-white cursor-pointer">Licencia Pricing</a>
          <a href="#quickstart" className="transition-colors hover:text-white cursor-pointer">Quickstart</a>
          <a href="#faq" className="transition-colors hover:text-white cursor-pointer">FAQ</a>
        </nav>

        {/* User / Action Cluster */}
        <div className="flex items-center gap-2.5">
          {isAuthenticated ? (
            <Link to="/servers">
              <Button size="sm" className="h-8 px-4 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md shadow-blue-600/30 gap-1.5 rounded-full cursor-pointer transition-all">
                Console ({userName?.split(" ")[0] || "User"})
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          ) : (
            <>
              <Link to="/login">
                <Button variant="ghost" size="sm" className="h-8 text-xs text-slate-300 hover:text-white hover:bg-white/5 rounded-full cursor-pointer transition-all">
                  Sign In
                </Button>
              </Link>
              <Button
                size="sm"
                onClick={() => onOpenCheckout("pro")}
                className="h-8 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-semibold shadow-md shadow-blue-600/30 gap-1.5 rounded-full cursor-pointer transition-all active:scale-95"
              >
                <Sparkles className="h-3.5 w-3.5 text-blue-200" />
                Upgrade to Pro
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
