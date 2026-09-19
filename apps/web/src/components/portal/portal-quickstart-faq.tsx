import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, Copy, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

export function PortalQuickstartFaq() {
  const [quickstartTab, setQuickstartTab] = useState<"compose" | "docker" | "k8s">("compose");
  const [copiedCode, setCopiedCode] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const snippets = {
    compose: `services:
  server-inventory-api:
    image: ghcr.io/rackmap/api:latest
    ports: ["3001:3001"]
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/rackmap
      - LICENCIA_URL=http://licencia:3003
      - LICENCIA_API_KEY=\${LICENCIA_API_KEY}
    restart: unless-stopped

  server-inventory-web:
    image: ghcr.io/rackmap/web:latest
    ports: ["3123:80"]
    restart: unless-stopped`,
    docker: `docker run -d --name rackmap-api \\
  -p 3001:3001 \\
  -e DATABASE_URL=postgresql://user:pass@db:5432/rackmap \\
  -e LICENCIA_URL=http://licencia:3003 \\
  ghcr.io/rackmap/api:latest

docker run -d --name rackmap-web \\
  -p 3123:80 \\
  ghcr.io/rackmap/web:latest`,
    k8s: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: rackmap-deployment
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/rackmap/api:latest
          ports: [{ containerPort: 3001 }]
        - name: web
          image: ghcr.io/rackmap/web:latest
          ports: [{ containerPort: 80 }]`,
  };

  function handleCopySnippet() {
    navigator.clipboard.writeText(snippets[quickstartTab]);
    setCopiedCode(true);
    toast.success("Deployment configuration copied to clipboard!");
    setTimeout(() => setCopiedCode(false), 2500);
  }

  const faqs = [
    {
      q: "Why agentless SSH instead of an installed background daemon?",
      a: "Installing and maintaining daemons across heterogeneous Linux distributions (Ubuntu, Debian, RHEL, Rocky) creates continuous maintenance burdens, potential memory leaks, and attack surfaces. RackMap connects over secure, ephemeral SSH using native kernel utilities (lshw, dmidecode, atop, ip, ss) with absolute zero permanent background overhead on your managed nodes.",
    },
    {
      q: "How does the Zero-Knowledge credential vault protect root passwords?",
      a: "Server credentials (SSH private keys, passwords, and sudo passphrases) are encrypted client-side directly in your browser using the WebCrypto AES-256-GCM standard before transmission. The master passphrase is never sent across the network or stored in the database. Even if the database were compromised, attackers only obtain unreadable ciphertext blocks.",
    },
    {
      q: "How does Licencia licensing function in air-gapped or private networks?",
      a: "RackMap includes dual-mode Licencia integration. In online mode, the server verifies subscriptions with the Licencia gateway. In isolated, air-gapped defense or on-prem environments with zero internet access, Licencia generates an Ed25519 cryptographically signed lease token that RackMap validates completely offline.",
    },
    {
      q: "What Linux distributions and architectures are supported?",
      a: "RackMap supports all major Linux distributions including Ubuntu 20.04+, Debian 11+, Rocky Linux 8+, AlmaLinux, RHEL 8+, CentOS Stream, and Arch Linux on x86_64, ARM64 (aarch64), and Raspberry Pi architectures.",
    },
    {
      q: "Can I sign up and test the Professional tier immediately?",
      a: "Yes! Click \"Upgrade to Pro\" to open our streamlined checkout. If you do not have an account yet, the checkout dialog includes a built-in Sign Up / Sign In tab. We provide instant license fulfillment and a 1-click \"Activate on this Instance\" button.",
    },
    {
      q: "Where is my inventory telemetry stored?",
      a: "RackMap is 100% self-hosted on your own infrastructure via Docker Compose or Kubernetes. All hardware specs, ATOP time-series logs, and encrypted secrets reside entirely within your sovereign network.",
    },
  ];

  return (
    <>
      {/* ================= ONE-MINUTE QUICKSTART ================= */}
      <section id="quickstart" className="py-24 border-t border-white/10 bg-slate-950/80 relative">
        <div className="container mx-auto max-w-5xl px-4 sm:px-6">
          <div className="text-center mb-12">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3.5 py-1 mb-3">
              One-Minute Deployment
            </Badge>
            <h2 className="text-3xl font-extrabold text-white tracking-tight">
              Self-Host on Any Linux Server with Docker
            </h2>
            <p className="mt-3 text-sm text-slate-400">
              Zero external dependencies. Runs seamlessly with SQLite or PostgreSQL and Licencia.
            </p>
          </div>

          <div className="rounded-2xl border border-white/15 bg-slate-900 p-4 sm:p-6 shadow-2xl space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
              {/* Snippet Tabs */}
              <div className="flex items-center gap-1 text-xs font-mono">
                <button
                  type="button"
                  onClick={() => setQuickstartTab("compose")}
                  className={`px-3 py-1 rounded-md cursor-pointer transition-all ${quickstartTab === "compose" ? "bg-blue-600 text-white font-bold" : "text-slate-400 hover:text-white"}`}
                >
                  docker-compose.yml
                </button>
                <button
                  type="button"
                  onClick={() => setQuickstartTab("docker")}
                  className={`px-3 py-1 rounded-md cursor-pointer transition-all ${quickstartTab === "docker" ? "bg-blue-600 text-white font-bold" : "text-slate-400 hover:text-white"}`}
                >
                  docker run (CLI)
                </button>
                <button
                  type="button"
                  onClick={() => setQuickstartTab("k8s")}
                  className={`px-3 py-1 rounded-md cursor-pointer transition-all ${quickstartTab === "k8s" ? "bg-blue-600 text-white font-bold" : "text-slate-400 hover:text-white"}`}
                >
                  k8s-deployment.yaml
                </button>
              </div>

              <Button
                size="sm"
                variant="outline"
                onClick={handleCopySnippet}
                className="h-8 border-white/10 text-xs gap-1.5 text-slate-300 hover:text-white cursor-pointer"
              >
                {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedCode ? "Copied!" : "Copy Snippet"}
              </Button>
            </div>

            <pre className="p-4 rounded-xl bg-slate-950 text-xs font-mono text-cyan-300 overflow-x-auto leading-relaxed border border-white/5">
              {snippets[quickstartTab]}
            </pre>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 text-xs">
              <div className="p-3 rounded-xl bg-white/5 border border-white/5">
                <span className="font-bold text-white block mb-1">1. Save Configuration</span>
                <p className="text-[11px] text-slate-400">Save your compose or deployment YAML into a clean directory.</p>
              </div>
              <div className="p-3 rounded-xl bg-white/5 border border-white/5">
                <span className="font-bold text-white block mb-1">2. Run Container</span>
                <p className="text-[11px] text-slate-400 font-mono">docker compose up -d</p>
              </div>
              <div className="p-3 rounded-xl bg-white/5 border border-white/5">
                <span className="font-bold text-white block mb-1">3. Access Web Portal</span>
                <p className="text-[11px] text-slate-400">Open http://localhost:3123 to register and connect your first server.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================= TESTIMONIALS ================= */}
      <section className="py-20 border-t border-white/10 bg-slate-950/60 relative">
        <div className="container mx-auto max-w-6xl px-4 sm:px-6">
          <div className="text-center max-w-2xl mx-auto mb-14">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3.5 py-1 mb-3">
              Production Validated
            </Badge>
            <h2 className="text-3xl font-extrabold text-white tracking-tight">
              Trusted by Infrastructure &amp; SRE Teams
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 rounded-2xl border border-white/10 bg-slate-900/60 space-y-4">
              <p className="text-xs sm:text-sm text-slate-300 italic leading-relaxed">
                &quot;We replaced heavy background monitoring daemons across 250+ bare-metal servers with RackMap. Zero memory footprint and our compliance team loves the client-side WebCrypto vault.&quot;
              </p>
              <div className="pt-2 border-t border-white/5">
                <span className="font-bold text-white text-xs block">Alexandre Moreau</span>
                <span className="text-[11px] text-slate-400">Principal SRE • FinTech Infrastructure</span>
              </div>
            </div>

            <div className="p-6 rounded-2xl border border-white/10 bg-slate-900/60 space-y-4">
              <p className="text-xs sm:text-sm text-slate-300 italic leading-relaxed">
                &quot;The ATOP time-machine saved us during an unexplainable kernel IO lockup at 3 AM. We scrubbed right to the exact timestamp and identified a rogue analytics worker immediately.&quot;
              </p>
              <div className="pt-2 border-t border-white/5">
                <span className="font-bold text-white text-xs block">Sarah Chen</span>
                <span className="text-[11px] text-slate-400">DevOps Team Lead • Cloud Native SaaS</span>
              </div>
            </div>

            <div className="p-6 rounded-2xl border border-white/10 bg-slate-900/60 space-y-4">
              <p className="text-xs sm:text-sm text-slate-300 italic leading-relaxed">
                &quot;Licencia air-gapped Ed25519 leasing made this an instant sell for our defense network. Complete node inventory and zero outbound internet connectivity requirements.&quot;
              </p>
              <div className="pt-2 border-t border-white/5">
                <span className="font-bold text-white text-xs block">Marcus Vance</span>
                <span className="text-[11px] text-slate-400">Director of Systems Security • SecureGov Labs</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================= FAQ ACCORDION ================= */}
      <section id="faq" className="py-24 border-t border-white/10 bg-slate-950 relative">
        <div className="container mx-auto max-w-4xl px-4 sm:px-6">
          <div className="text-center mb-14">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3.5 py-1 mb-3">
              Frequently Asked Questions
            </Badge>
            <h2 className="text-3xl font-extrabold text-white tracking-tight">
              Architecture &amp; Licensing Details
            </h2>
          </div>

          <div className="space-y-4">
            {faqs.map((faq, i) => {
              const isOpen = openFaq === i;
              return (
                <div
                  key={i}
                  className="rounded-xl border border-white/10 bg-slate-900/60 overflow-hidden transition-all"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : i)}
                    className="w-full flex items-center justify-between p-5 text-left text-sm font-semibold text-white hover:text-blue-400 transition-colors cursor-pointer"
                  >
                    <span>{faq.q}</span>
                    {isOpen ? (
                      <ChevronUp className="h-4 w-4 text-blue-400 shrink-0" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 text-xs sm:text-sm text-slate-300 leading-relaxed border-t border-white/5 pt-3">
                      {faq.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}
