import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CloudCog,
  Server,
  Shield,
  Lock,
  Terminal,
  Activity,
  Check,
  ArrowRight,
  Copy,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Users,
  KeyRound,
  BarChart3,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/portal")({
  component: PortalPage,
});

export function PortalPage() {
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("annual");
  const [activeConsoleTab, setActiveConsoleTab] = useState<"servers" | "atop" | "vault" | "users">("servers");
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const dockerSnippet = `services:
  server-inventory-api:
    image: ghcr.io/rackmap/api:latest
    ports: ["3001:3001"]
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/rackmap
      - LICENCIA_PUBLIC_KEY=\${LICENCIA_PUBLIC_KEY}
      - LICENCIA_PRODUCT_SLUG=rackmap
    restart: unless-stopped

  server-inventory-web:
    image: ghcr.io/rackmap/web:latest
    ports: ["3123:80"]
    restart: unless-stopped`;

  function handleCopyDocker() {
    navigator.clipboard.writeText(dockerSnippet);
    setCopiedCode(true);
    toast.success("Docker Compose configuration copied to clipboard!");
    setTimeout(() => setCopiedCode(false), 2500);
  }

  const plans = [
    {
      id: "free",
      name: "Community Edition",
      badge: "Open Source Core",
      badgeVariant: "secondary" as const,
      priceMonthly: 0,
      priceAnnual: 0,
      description: "For homelabs, independent developers, and small test environments.",
      serverLimit: "Up to 10 Managed Servers",
      features: [
        "10 Linux nodes maximum",
        "Zero-agent SSH discovery",
        "Client-side Zero-Knowledge vault (AES-256-GCM)",
        "Live system status & metrics",
        "5-minute polling interval",
        "Community forum support",
      ],
      missing: [
        "Historical ATOP time-travel replay",
        "Remote OS user & sudo privilege audit",
        "Automated daily hardware sync",
        "Multi-channel alert webhooks",
        "Air-gapped offline activation",
      ],
      cta: "Get Started Free",
      ctaVariant: "outline" as const,
      highlighted: false,
    },
    {
      id: "pro",
      name: "Professional",
      badge: "Most Popular",
      badgeVariant: "default" as const,
      priceMonthly: 39,
      priceAnnual: 31,
      description: "For growing engineering teams, DevOps squads, and production Linux clusters.",
      serverLimit: "Up to 100 Managed Servers",
      features: [
        "Up to 100 Linux nodes",
        "Everything in Community, plus:",
        "ATOP kernel metric historical replay (30-day)",
        "Remote OS users, sudoers & groups discovery",
        "Automated daily background hardware sync",
        "SSL certificate auto-expiry alarms",
        "Slack, Discord & Webhook alerting",
        "Priority email & ticket support",
        "Licencia digital key activation",
      ],
      missing: [
        "Offline air-gapped cryptographic validation",
        "Dedicated enterprise SLA & onboarding",
      ],
      cta: "Upgrade to Pro",
      ctaVariant: "default" as const,
      highlighted: true,
    },
    {
      id: "enterprise",
      name: "Enterprise",
      badge: "High Security & Scale",
      badgeVariant: "outline" as const,
      priceMonthly: 249,
      priceAnnual: 199,
      description: "For mission-critical infrastructure, regulated industries, and air-gapped environments.",
      serverLimit: "Unlimited Nodes & Users",
      features: [
        "Unlimited servers & infinite scalability",
        "Everything in Professional, plus:",
        "Air-gapped offline Licencia activation",
        "365-day ATOP & audit trail retention",
        "Role-Based Access Control (RBAC) & SSO/SAML",
        "Audit log streaming to SIEM (Datadog, Splunk)",
        "Custom SSH discovery scripts & modules",
        "Dedicated account architect & 99.9% SLA",
      ],
      missing: [],
      cta: "Contact Enterprise Sales",
      ctaVariant: "outline" as const,
      highlighted: false,
    },
  ];

  const faqs = [
    {
      q: "Why agentless SSH instead of an installed agent daemon?",
      a: "Installing and maintaining background agents across 50+ heterogeneous Linux servers introduces CPU overhead, security attack surface, and upgrade fatigue. RackMap uses secure, ephemeral SSH commands and native tools (lshw, dmidecode, atop, ip, ss) to collect telemetry with zero persistent footprint on target machines.",
    },
    {
      q: "How does the Zero-Knowledge credential vault protect our root passwords?",
      a: "Credentials (SSH keys, root passwords, sudoer passphrases) are encrypted directly in your browser using WebCrypto AES-256-GCM before ever touching the network. The master passphrase is never transmitted to the RackMap API or stored in PostgreSQL. Even in a catastrophic database breach, attackers only obtain unreadable ciphertext blocks.",
    },
    {
      q: "How does Licencia licensing work in private or air-gapped networks?",
      a: "RackMap natively integrates with Licencia. In online modes, the server validates its entitlement with the Licencia gateway. For strict air-gapped or isolated defense networks, Licencia issues cryptographically signed Ed25519 offline license payloads that RackMap validates completely offline with no outbound Internet connection required.",
    },
    {
      q: "What Linux distributions and architectures are supported?",
      a: "RackMap supports all major enterprise Linux distributions including Ubuntu 20.04+, Debian 11+, Rocky Linux 8+, AlmaLinux, RHEL 8+, CentOS Stream, and Arch Linux on x86_64, aarch64 (ARM64), and Raspberry Pi architectures.",
    },
    {
      q: "Can I start with Community Edition and upgrade later?",
      a: "Yes! You can deploy RackMap Community for free in minutes. When you need more than 10 servers, ATOP historical replays, or remote OS user audits, simply paste your Licencia license key into the Console Settings to instantly unlock all capabilities with zero server downtime.",
    },
    {
      q: "Can I self-host RackMap on our private on-premises Kubernetes or Docker cluster?",
      a: "RackMap is 100% self-hosted via Docker Compose, Docker Swarm, or Kubernetes. Your server telemetry, logs, and encrypted credentials reside entirely within your sovereign network infrastructure.",
    },
  ];

  const comparisonCategories = [
    {
      category: "Fleet Capacity & Architecture",
      items: [
        { feature: "Managed Server Nodes", free: "Up to 10", pro: "Up to 100", ent: "Unlimited" },
        { feature: "Agentless SSH Architecture", free: true, pro: true, ent: true },
        { feature: "Zero-Knowledge AES-256-GCM Vault", free: true, pro: true, ent: true },
        { feature: "Multi-User Access Control", free: "3 Users", pro: "15 Users", ent: "Unlimited" },
        { feature: "Self-Hosted Docker Deployment", free: true, pro: true, ent: true },
      ],
    },
    {
      category: "Discovery & Performance Engine",
      items: [
        { feature: "Hardware & Network Discovery", free: "Basic", pro: "Deep (lshw/dmidecode)", ent: "Full + Custom" },
        { feature: "Real-time Metrics Polling", free: "5 Minutes", pro: "1 Minute", ent: "Custom (10s)" },
        { feature: "Historical ATOP Spike Replay", free: false, pro: "30 Days", ent: "365 Days" },
        { feature: "Remote OS Users & Sudo Audit", free: false, pro: true, ent: true },
        { feature: "Automated Daily Fleet Refresh", free: false, pro: true, ent: true },
      ],
    },
    {
      category: "Security & Licensing",
      items: [
        { feature: "Licencia Online Key Activation", free: true, pro: true, ent: true },
        { feature: "Air-gapped Cryptographic Activation", free: false, pro: false, ent: true },
        { feature: "SSL Certificate Expiry Alarms", free: "Manual", pro: "Automated", ent: "Automated" },
        { feature: "SIEM Audit Log Streaming", free: false, pro: false, ent: true },
        { feature: "Support SLA", free: "Community", pro: "24h Email", ent: "1h Priority / 99.9% SLA" },
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 selection:bg-primary selection:text-primary-foreground">
      {/* Sticky Glass Navbar */}
      <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-slate-950/80 backdrop-blur-xl transition-all">
        <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link to="/portal" className="flex items-center gap-2.5 group">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 text-white shadow-lg shadow-blue-500/25 transition-transform group-hover:scale-105">
                <CloudCog className="h-5 w-5" />
              </div>
              <span className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
                RackMap
                <Badge variant="outline" className="border-blue-500/40 text-blue-400 text-[10px] px-1.5 py-0 uppercase font-mono">
                  Portal
                </Badge>
              </span>
            </Link>
          </div>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
            <a href="#features" className="transition-colors hover:text-white">Features</a>
            <a href="#demo" className="transition-colors hover:text-white">Live Preview</a>
            <a href="#pricing" className="transition-colors hover:text-white">Licencia Pricing</a>
            <a href="#quickstart" className="transition-colors hover:text-white">Quickstart</a>
            <a href="#faq" className="transition-colors hover:text-white">FAQ</a>
          </nav>

          <div className="flex items-center gap-3">
            <Link to="/login">
              <Button variant="ghost" size="sm" className="text-slate-300 hover:text-white hover:bg-white/5">
                Sign In
              </Button>
            </Link>
            <Link to="/servers">
              <Button size="sm" className="bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30 gap-1.5">
                Launch Console
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden pt-20 pb-24 md:pt-28 md:pb-32">
        {/* Glow ambient backgrounds */}
        <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[550px] w-[800px] -translate-x-1/2 rounded-full bg-blue-600/20 blur-[130px]" />
        <div className="pointer-events-none absolute top-1/3 right-10 -z-10 h-[400px] w-[400px] rounded-full bg-indigo-600/15 blur-[120px]" />

        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center text-center">
            {/* Announcement Pill */}
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3.5 py-1 text-xs font-medium text-blue-400 shadow-inner backdrop-blur-md mb-6">
              <Sparkles className="h-3.5 w-3.5 text-blue-300" />
              <span>Licencia-Powered Enterprise Subscriptions Active</span>
              <span className="hidden sm:inline text-blue-400/60">•</span>
              <span className="hidden sm:inline text-slate-300">Free Community, Pro & Enterprise</span>
            </div>

            {/* Headline */}
            <h1 className="max-w-4xl text-4xl font-extrabold tracking-tight text-white sm:text-6xl sm:leading-[1.15]">
              Agentless Server Fleet Intelligence &amp;{" "}
              <span className="bg-gradient-to-r from-blue-400 via-indigo-300 to-sky-400 bg-clip-text text-transparent">
                Zero-Knowledge Vault
              </span>
            </h1>

            {/* Subheading */}
            <p className="mt-6 max-w-2xl text-lg text-slate-400 sm:text-xl sm:leading-relaxed">
              Discover hardware topology, replay deep ATOP kernel performance spikes, audit remote sudoers, and safeguard root credentials with client-side AES-256-GCM cryptography. Zero agent overhead.
            </p>

            {/* CTAs */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <Link to="/login">
                <Button size="lg" className="h-12 px-7 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-xl shadow-blue-600/30 gap-2 font-semibold">
                  Get Started Free
                  <ArrowRight className="h-4.5 w-4.5" />
                </Button>
              </Link>
              <a href="#pricing">
                <Button size="lg" variant="outline" className="h-12 px-7 border-white/15 bg-white/5 hover:bg-white/10 text-white font-medium backdrop-blur-md">
                  Explore Plans &amp; Pricing
                </Button>
              </a>
              <a href="#demo">
                <Button size="lg" variant="ghost" className="h-12 px-6 text-slate-300 hover:text-white hover:bg-white/5 gap-2">
                  <Activity className="h-4 w-4 text-blue-400" />
                  Interactive Demo
                </Button>
              </a>
            </div>

            {/* Trust bullet highlights */}
            <div className="mt-12 flex flex-wrap items-center justify-center gap-6 sm:gap-8 text-xs sm:text-sm text-slate-400">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-blue-400" />
                <span>Zero Agent Daemons</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-blue-400" />
                <span>Client-Side AES-256-GCM</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-blue-400" />
                <span>High-Precision ATOP Replay</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-blue-400" />
                <span>Air-Gapped Licencia Key Support</span>
              </div>
            </div>
          </div>

          {/* Interactive Mock Console Showcase */}
          <div id="demo" className="mt-16 scroll-mt-24">
            <div className="rounded-2xl border border-white/15 bg-slate-900/90 p-2 shadow-2xl shadow-blue-950/50 backdrop-blur-2xl sm:p-4">
              {/* Window Frame header */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3 px-3">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-red-500/80 inline-block" />
                    <span className="h-3 w-3 rounded-full bg-amber-500/80 inline-block" />
                    <span className="h-3 w-3 rounded-full bg-emerald-500/80 inline-block" />
                  </div>
                  <span className="ml-2 font-mono text-xs text-slate-400">rackmap-console — live demo mode</span>
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-1 rounded-lg bg-slate-950/70 p-1 border border-white/10">
                  <button
                    type="button"
                    onClick={() => setActiveConsoleTab("servers")}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all ${
                      activeConsoleTab === "servers"
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    <Server className="h-3.5 w-3.5" />
                    Server Fleet (4 Online)
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveConsoleTab("atop")}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all ${
                      activeConsoleTab === "atop"
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    <Activity className="h-3.5 w-3.5" />
                    ATOP Replay (Pro)
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveConsoleTab("vault")}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all ${
                      activeConsoleTab === "vault"
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    <Shield className="h-3.5 w-3.5" />
                    Zero-Knowledge Vault
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveConsoleTab("users")}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all ${
                      activeConsoleTab === "users"
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    <Users className="h-3.5 w-3.5" />
                    Remote Sudoers (Pro)
                  </button>
                </div>
              </div>

              {/* Tab 1: Server Fleet */}
              {activeConsoleTab === "servers" && (
                <div className="p-4 sm:p-6 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {[
                      {
                        name: "prod-db-primary-01",
                        ip: "10.0.4.12",
                        os: "Ubuntu 22.04 LTS",
                        cores: "16 vCPU",
                        ram: "64 GB",
                        cpuLoad: 24,
                        ramLoad: 68,
                        atopStatus: "Active Log",
                        tag: "Production",
                      },
                      {
                        name: "api-cluster-worker-03",
                        ip: "10.0.4.88",
                        os: "Debian 12 Bookworm",
                        cores: "8 vCPU",
                        ram: "32 GB",
                        cpuLoad: 48,
                        ramLoad: 52,
                        atopStatus: "Active Log",
                        tag: "API Core",
                      },
                      {
                        name: "k8s-ingress-gateway",
                        ip: "192.168.10.15",
                        os: "Rocky Linux 9.3",
                        cores: "8 vCPU",
                        ram: "16 GB",
                        cpuLoad: 12,
                        ramLoad: 31,
                        atopStatus: "Active Log",
                        tag: "Ingress",
                      },
                      {
                        name: "backup-storage-nas",
                        ip: "192.168.20.5",
                        os: "Ubuntu 24.04 LTS",
                        cores: "4 vCPU",
                        ram: "16 GB",
                        cpuLoad: 8,
                        ramLoad: 41,
                        atopStatus: "Active Log",
                        tag: "Storage",
                      },
                    ].map((srv, idx) => (
                      <div
                        key={idx}
                        className="rounded-xl border border-white/10 bg-slate-950/60 p-4 hover:border-blue-500/40 transition-all group"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                            ONLINE • SSH OK
                          </Badge>
                          <span className="text-[10px] font-mono text-slate-400">{srv.tag}</span>
                        </div>
                        <h4 className="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors truncate">
                          {srv.name}
                        </h4>
                        <p className="text-xs font-mono text-slate-400 mt-0.5">{srv.ip} • {srv.os}</p>

                        <div className="mt-4 space-y-2 text-xs">
                          <div>
                            <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                              <span>CPU Utilization</span>
                              <span className="font-mono text-slate-200">{srv.cpuLoad}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full transition-all"
                                style={{ width: `${srv.cpuLoad}%` }}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                              <span>Memory Utilization</span>
                              <span className="font-mono text-slate-200">{srv.ramLoad}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                              <div
                                className="h-full bg-indigo-500 rounded-full transition-all"
                                style={{ width: `${srv.ramLoad}%` }}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between text-[11px]">
                          <span className="text-slate-400">{srv.cores} • {srv.ram}</span>
                          <span className="inline-flex items-center gap-1 text-blue-400 font-mono">
                            <Activity className="h-3 w-3" />
                            {srv.atopStatus}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end pt-2">
                    <Link to="/servers">
                      <Button variant="outline" size="sm" className="border-white/10 text-xs gap-1.5">
                        Manage all servers in Console
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  </div>
                </div>
              )}

              {/* Tab 2: ATOP Replay */}
              {activeConsoleTab === "atop" && (
                <div className="p-4 sm:p-6 space-y-4">
                  <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold text-blue-300 flex items-center gap-2">
                        <Activity className="h-4 w-4" />
                        Historical ATOP Diagnostic Replay Engine
                      </h4>
                      <p className="text-xs text-slate-400 mt-1">
                        Timeline recorded from <code className="text-blue-400">/var/log/atop/atop_20260918</code> via agentless SFTP sync.
                      </p>
                    </div>
                    <Badge className="bg-blue-600/30 text-blue-300 border border-blue-500/40 px-2.5 py-1 text-xs">
                      Licencia Pro Feature
                    </Badge>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-white/10 bg-slate-950/80">
                    <table className="w-full text-left text-xs font-mono">
                      <thead className="border-b border-white/10 bg-white/5 text-slate-400">
                        <tr>
                          <th className="py-2.5 px-3">TIMESTAMP</th>
                          <th className="py-2.5 px-3">PID</th>
                          <th className="py-2.5 px-3">COMMAND</th>
                          <th className="py-2.5 px-3">CPU %</th>
                          <th className="py-2.5 px-3">VSIZE</th>
                          <th className="py-2.5 px-3">RSIZE</th>
                          <th className="py-2.5 px-3">DISK READ/WRITE</th>
                          <th className="py-2.5 px-3">BOTTLENECK DIAGNOSIS</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5 text-slate-300">
                        <tr className="bg-red-500/10 hover:bg-red-500/15 transition-colors">
                          <td className="py-2 px-3 text-red-400">14:22:10 UTC</td>
                          <td className="py-2 px-3">9482</td>
                          <td className="py-2 px-3 font-semibold text-white">postgres: worker [analytics]</td>
                          <td className="py-2 px-3 text-red-400 font-bold">98.2%</td>
                          <td className="py-2 px-3">12.4 GB</td>
                          <td className="py-2 px-3">8.1 GB</td>
                          <td className="py-2 px-3">142 MB/s W</td>
                          <td className="py-2 px-3 text-red-300">Sequential Scan / High IO Wait</td>
                        </tr>
                        <tr className="hover:bg-white/5 transition-colors">
                          <td className="py-2 px-3 text-slate-400">14:22:10 UTC</td>
                          <td className="py-2 px-3">1204</td>
                          <td className="py-2 px-3">node /app/dist/main.js</td>
                          <td className="py-2 px-3 text-amber-400">14.1%</td>
                          <td className="py-2 px-3">1.2 GB</td>
                          <td className="py-2 px-3">820 MB</td>
                          <td className="py-2 px-3">1.2 MB/s R</td>
                          <td className="py-2 px-3 text-emerald-400">Normal Operation</td>
                        </tr>
                        <tr className="hover:bg-white/5 transition-colors">
                          <td className="py-2 px-3 text-slate-400">14:22:10 UTC</td>
                          <td className="py-2 px-3">389</td>
                          <td className="py-2 px-3">dockerd --default-runtime</td>
                          <td className="py-2 px-3">6.4%</td>
                          <td className="py-2 px-3">2.4 GB</td>
                          <td className="py-2 px-3">1.1 GB</td>
                          <td className="py-2 px-3">4.8 MB/s W</td>
                          <td className="py-2 px-3 text-emerald-400">Normal Operation</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Tab 3: Zero-Knowledge Vault */}
              {activeConsoleTab === "vault" && (
                <div className="p-4 sm:p-6 space-y-4">
                  <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold text-indigo-300 flex items-center gap-2">
                        <Lock className="h-4 w-4" />
                        Client-Side WebCrypto AES-256-GCM Vault
                      </h4>
                      <p className="text-xs text-slate-400 mt-1">
                        Zero knowledge security: Secrets are encrypted on the client before being sent over the wire.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => setVaultUnlocked((v) => !v)}
                      className={vaultUnlocked ? "bg-amber-600 hover:bg-amber-500" : "bg-indigo-600 hover:bg-indigo-500"}
                    >
                      {vaultUnlocked ? "Lock Secret with Master Key" : "Simulate Master Key Unlock"}
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-white/10 bg-slate-950 p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">What the API &amp; DB Stores</span>
                        <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">Ciphertext Only</Badge>
                      </div>
                      <pre className="text-xs font-mono text-slate-400 bg-slate-900 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all border border-white/5">
                        {`"encryptedPassword": "aes-256-gcm:iv:8a9b7c6d5e4f3a2b:tag:4d3c2b1a:e48ac917b2046892e67df10b9ca30514fe04a11f29ba04882199b7ca783f06d"
"salt": "d04a621ef8839cb80172e..."`}
                      </pre>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-slate-950 p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Client Browser Decryption</span>
                        <Badge variant="outline" className={`text-[10px] ${vaultUnlocked ? "text-emerald-400 border-emerald-500/30" : "text-slate-500"}`}>
                          {vaultUnlocked ? "Decrypted In Memory" : "Locked / Encrypted"}
                        </Badge>
                      </div>
                      <div className="rounded-lg bg-slate-900 p-3 border border-white/5 font-mono text-xs flex items-center justify-between">
                        {vaultUnlocked ? (
                          <span className="text-emerald-300 font-bold">r00t_P@ssw0rd!#2026_Secure</span>
                        ) : (
                          <span className="text-slate-500">••••••••••••••••••••••••••••••••</span>
                        )}
                        <KeyRound className={`h-4 w-4 ${vaultUnlocked ? "text-emerald-400" : "text-slate-600"}`} />
                      </div>
                      <p className="text-[11px] text-slate-500">
                        The plaintext never leaves the browser. Server administrators cannot read credentials even with direct SQL access.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 4: Remote Sudoers */}
              {activeConsoleTab === "users" && (
                <div className="p-4 sm:p-6 space-y-4">
                  <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold text-sky-300 flex items-center gap-2">
                        <Users className="h-4 w-4" />
                        Remote OS Users &amp; Sudo Privilege Auditing
                      </h4>
                      <p className="text-xs text-slate-400 mt-1">
                        Discovered live from <code className="text-sky-400">/etc/passwd</code>, <code className="text-sky-400">/etc/sudoers.d/</code> and <code className="text-sky-400">~/.ssh/authorized_keys</code>.
                      </p>
                    </div>
                    <Badge className="bg-sky-600/30 text-sky-300 border border-sky-500/40 px-2.5 py-1 text-xs">
                      Licencia Pro Feature
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {[
                      { user: "root", uid: 0, gid: 0, sudo: "ALL=(ALL:ALL) ALL", shell: "/bin/bash", keys: 1, color: "text-red-400" },
                      { user: "ansible-deploy", uid: 1001, gid: 1001, sudo: "NOPASSWD: ALL", shell: "/bin/bash", keys: 3, color: "text-amber-400" },
                      { user: "dev-anshukushwaha", uid: 1002, gid: 1002, sudo: "(ALL) PASSWD: ALL", shell: "/bin/zsh", keys: 2, color: "text-blue-400" },
                    ].map((u, i) => (
                      <div key={i} className="rounded-lg border border-white/10 bg-slate-950 p-3 text-xs space-y-2">
                        <div className="flex items-center justify-between">
                          <span className={`font-mono font-bold ${u.color}`}>{u.user}</span>
                          <span className="text-[10px] text-slate-500">UID: {u.uid}</span>
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono space-y-1">
                          <p>Shell: <span className="text-slate-300">{u.shell}</span></p>
                          <p>Sudo: <span className="text-amber-300">{u.sudo}</span></p>
                          <p>SSH Keys: <span className="text-emerald-400">{u.keys} Authorized</span></p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Feature Pillars Grid */}
      <section id="features" className="py-20 border-t border-white/10 bg-slate-950/60 relative">
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3 py-1 mb-3">
              Core Architecture
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              Engineered for Scalable, Secure Linux Operations
            </h2>
            <p className="mt-4 text-base sm:text-lg text-slate-400">
              Traditional server managers require heavy agents, insecure central password caches, or complex SaaS agents. RackMap changes the paradigm.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: Terminal,
                title: "100% Agentless SSH Operation",
                desc: "No agent daemons to install, update, or debug. Connects via standard SSH and native Linux utilities (lshw, dmidecode, ip, ss) with zero background resource consumption on targets.",
                color: "text-sky-400",
                bg: "bg-sky-500/10",
              },
              {
                icon: Shield,
                title: "Client Zero-Knowledge Vault",
                desc: "Root passwords and SSH keys are encrypted in-browser using WebCrypto AES-256-GCM. The API and database store only salted ciphertext. Your master passphrase never leaves memory.",
                color: "text-emerald-400",
                bg: "bg-emerald-500/10",
              },
              {
                icon: Activity,
                title: "ATOP Kernel Telemetry & Replay",
                desc: "Replay high-resolution ATOP performance logs second-by-second. Detect rogue processes, memory leaks, and disk IO wait bottlenecks that happened hours or days ago.",
                color: "text-blue-400",
                bg: "bg-blue-500/10",
              },
              {
                icon: Users,
                title: "Remote OS & Sudo Privilege Audits",
                desc: "Continuously audit /etc/passwd, /etc/sudoers, and authorized keys across your fleet. Flag unauthorized sudo escalations, orphaned users, and stale credentials automatically.",
                color: "text-indigo-400",
                bg: "bg-indigo-500/10",
              },
              {
                icon: BarChart3,
                title: "Comprehensive Fleet Analytics",
                desc: "Export clean PDF and CSV executive summaries of your entire hardware inventory, memory distributions, OS version fragmentation, and upcoming SSL certificate renewals.",
                color: "text-purple-400",
                bg: "bg-purple-500/10",
              },
              {
                icon: Zap,
                title: "Licencia Cryptographic Gating",
                desc: "Seamlessly scales from Community to Enterprise. Supports cryptographic Ed25519 license validation for completely offline and air-gapped secure enterprise deployments.",
                color: "text-amber-400",
                bg: "bg-amber-500/10",
              },
            ].map((f, i) => {
              const Icon = f.icon;
              return (
                <div
                  key={i}
                  className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 hover:border-white/20 transition-all hover:shadow-xl hover:shadow-blue-950/30 group"
                >
                  <div className={`h-11 w-11 rounded-xl ${f.bg} flex items-center justify-center ${f.color} mb-5 group-hover:scale-110 transition-transform`}>
                    <Icon className="h-5.5 w-5.5" />
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-2">{f.title}</h3>
                  <p className="text-sm text-slate-400 leading-relaxed">{f.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Pricing Section powered by Licencia */}
      <section id="pricing" className="py-20 border-t border-white/10 bg-slate-950 relative overflow-hidden">
        <div className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[600px] w-[900px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600/10 blur-[150px]" />

        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-12">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3 py-1 mb-3">
              Licencia Subscription Tiers
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              Predictable Pricing for Any Scale
            </h2>
            <p className="mt-4 text-base sm:text-lg text-slate-400">
              Start with the full-featured Free Community edition. Upgrade when your fleet grows or when you need deep ATOP diagnostic replay and air-gapped activation.
            </p>

            {/* Billing cycle toggle */}
            <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-white/15 bg-slate-900/80 p-1.5 backdrop-blur-md">
              <button
                type="button"
                onClick={() => setBillingCycle("monthly")}
                className={`rounded-full px-5 py-1.5 text-xs font-semibold transition-all ${
                  billingCycle === "monthly"
                    ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Monthly Billing
              </button>
              <button
                type="button"
                onClick={() => setBillingCycle("annual")}
                className={`rounded-full px-5 py-1.5 text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  billingCycle === "annual"
                    ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Annual Billing
                <span className="rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] px-2 py-0.5 font-bold">
                  Save 20%
                </span>
              </button>
            </div>
          </div>

          {/* Pricing Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-stretch">
            {plans.map((p) => {
              const price = billingCycle === "annual" ? p.priceAnnual : p.priceMonthly;
              return (
                <div
                  key={p.id}
                  className={`rounded-2xl p-8 flex flex-col justify-between transition-all relative ${
                    p.highlighted
                      ? "border-2 border-blue-500 bg-slate-900/90 shadow-2xl shadow-blue-600/20 ring-1 ring-blue-500/50"
                      : "border border-white/10 bg-slate-900/40 hover:border-white/20"
                  }`}
                >
                  {p.highlighted && (
                    <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                      <Badge className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white border-0 px-3.5 py-1 text-xs font-bold uppercase tracking-wider shadow-lg shadow-blue-500/30">
                        {p.badge}
                      </Badge>
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between">
                      <h3 className="text-xl font-bold text-white">{p.name}</h3>
                      {!p.highlighted && (
                        <Badge variant={p.badgeVariant} className="text-xs">
                          {p.badge}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-slate-400 min-h-[36px]">{p.description}</p>

                    {/* Price display */}
                    <div className="mt-6 flex items-baseline gap-1">
                      <span className="text-4xl font-extrabold text-white">${price}</span>
                      <span className="text-xs font-medium text-slate-400">
                        {p.priceMonthly === 0 ? "/ forever" : "/ node group / mo"}
                      </span>
                    </div>
                    {billingCycle === "annual" && p.priceMonthly > 0 && (
                      <p className="text-[11px] text-emerald-400 mt-1 font-medium">
                        Billed annually (${price * 12}/yr) — includes 2 months free
                      </p>
                    )}

                    <div className="mt-4 p-2.5 rounded-lg bg-white/5 border border-white/5 text-center text-xs font-semibold text-blue-300">
                      {p.serverLimit}
                    </div>

                    {/* Features checklist */}
                    <div className="mt-6 space-y-3 text-xs">
                      <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">Included Capabilities</p>
                      {p.features.map((feat, idx) => (
                        <div key={idx} className="flex items-start gap-2.5 text-slate-300">
                          <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                          <span>{feat}</span>
                        </div>
                      ))}
                      {p.missing.map((feat, idx) => (
                        <div key={idx} className="flex items-start gap-2.5 text-slate-500">
                          <span className="h-4 w-4 shrink-0 text-center font-bold text-slate-600">•</span>
                          <span className="line-through">{feat}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-8 pt-4 border-t border-white/10">
                    <Link to="/login" className="w-full">
                      <Button
                        variant={p.ctaVariant}
                        className={`w-full h-11 text-sm font-semibold ${
                          p.highlighted
                            ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30"
                            : "border-white/15 text-white hover:bg-white/10"
                        }`}
                      >
                        {p.cta}
                      </Button>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Full Comparison Table */}
          <div className="mt-20">
            <h3 className="text-2xl font-bold text-white text-center mb-8">
              Detailed Feature Matrix &amp; Gating
            </h3>

            <div className="overflow-x-auto rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur-xl">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <th className="py-4 px-6 font-semibold text-white w-2/5">Feature Dimension</th>
                    <th className="py-4 px-4 font-semibold text-slate-300 text-center w-1/5">Community</th>
                    <th className="py-4 px-4 font-semibold text-blue-400 text-center w-1/5">Professional</th>
                    <th className="py-4 px-4 font-semibold text-indigo-300 text-center w-1/5">Enterprise</th>
                  </tr>
                </thead>
                {comparisonCategories.map((cat, catIdx) => (
                    <tbody key={catIdx} className="divide-y divide-white/5">
                      <tr className="bg-slate-950/80">
                        <td colSpan={4} className="py-2.5 px-6 font-bold text-xs uppercase tracking-wider text-blue-400">
                          {cat.category}
                        </td>
                      </tr>
                      {cat.items.map((item, itemIdx) => (
                        <tr key={itemIdx} className="hover:bg-white/5 transition-colors">
                          <td className="py-3 px-6 text-slate-300 font-medium">{item.feature}</td>
                          <td className="py-3 px-4 text-center">
                            {typeof item.free === "boolean" ? (
                              item.free ? (
                                <Check className="h-4 w-4 text-emerald-400 mx-auto" />
                              ) : (
                                <span className="text-slate-600 font-mono">—</span>
                              )
                            ) : (
                              <span className="text-slate-300 font-medium">{item.free}</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-center">
                            {typeof item.pro === "boolean" ? (
                              item.pro ? (
                                <Check className="h-4 w-4 text-emerald-400 mx-auto" />
                              ) : (
                                <span className="text-slate-600 font-mono">—</span>
                              )
                            ) : (
                              <span className="text-blue-300 font-medium">{item.pro}</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-center">
                            {typeof item.ent === "boolean" ? (
                              item.ent ? (
                                <Check className="h-4 w-4 text-emerald-400 mx-auto" />
                              ) : (
                                <span className="text-slate-600 font-mono">—</span>
                              )
                            ) : (
                              <span className="text-indigo-300 font-bold">{item.ent}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* Quickstart / 1-Minute Deployment Section */}
      <section id="quickstart" className="py-20 border-t border-white/10 bg-slate-950/80 relative">
        <div className="container mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3 py-1 mb-3">
              One-Minute Deployment
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              Self-Host on Any Linux Server with Docker
            </h2>
            <p className="mt-3 text-base text-slate-400">
              Zero dependencies outside of Docker and Docker Compose. Spin up in 60 seconds.
            </p>
          </div>

          <div className="rounded-2xl border border-white/15 bg-slate-900 p-4 sm:p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <span className="text-xs font-mono text-slate-300">docker-compose.yml</span>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCopyDocker}
                className="h-8 border-white/10 text-xs gap-1.5 text-slate-300 hover:text-white"
              >
                {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedCode ? "Copied!" : "Copy YAML"}
              </Button>
            </div>

            <pre className="p-4 rounded-xl bg-slate-950 text-xs font-mono text-blue-300 overflow-x-auto leading-relaxed border border-white/5">
              {dockerSnippet}
            </pre>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
              <div className="p-3 rounded-lg bg-white/5 border border-white/5">
                <span className="text-xs font-bold text-white block mb-1">1. Save configuration</span>
                <p className="text-[11px] text-slate-400">Create a clean directory and write the YAML file.</p>
              </div>
              <div className="p-3 rounded-lg bg-white/5 border border-white/5">
                <span className="text-xs font-bold text-white block mb-1">2. Run compose</span>
                <p className="text-[11px] text-slate-400 font-mono">docker compose up -d</p>
              </div>
              <div className="p-3 rounded-lg bg-white/5 border border-white/5">
                <span className="text-xs font-bold text-white block mb-1">3. Access Web UI</span>
                <p className="text-[11px] text-slate-400">Open http://localhost:3123 and register the admin account.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="py-20 border-t border-white/10 bg-slate-950 relative">
        <div className="container mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3 py-1 mb-3">
              Frequently Asked Questions
            </Badge>
            <h2 className="text-3xl font-extrabold text-white tracking-tight">
              Everything You Need to Know
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
                    className="w-full flex items-center justify-between p-5 text-left text-sm font-semibold text-white hover:text-blue-400 transition-colors"
                  >
                    <span>{faq.q}</span>
                    {isOpen ? (
                      <ChevronUp className="h-4 w-4 text-blue-400 shrink-0" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 text-xs sm:text-sm text-slate-400 leading-relaxed border-t border-white/5 pt-3">
                      {faq.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Final CTA Banner */}
      <section className="py-20 border-t border-white/10 bg-gradient-to-b from-slate-950 to-blue-950/40 relative overflow-hidden">
        <div className="container mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">
            Ready to Streamline Your Linux Infrastructure?
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-300 max-w-2xl mx-auto">
            Join DevOps engineers and system administrators who manage production servers with zero agent overhead and total cryptographic privacy.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link to="/login">
              <Button size="lg" className="h-12 px-8 bg-blue-600 hover:bg-blue-500 text-white shadow-xl shadow-blue-600/40 font-semibold gap-2">
                Launch Console Now
                <ArrowRight className="h-4.5 w-4.5" />
              </Button>
            </Link>
            <Link to="/servers">
              <Button size="lg" variant="outline" className="h-12 px-8 border-white/15 text-white hover:bg-white/10">
                Go to Server Inventory
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 bg-slate-950 py-12 text-xs text-slate-400">
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white">
              <CloudCog className="h-4 w-4" />
            </div>
            <span className="font-semibold text-white">RackMap</span>
            <span>•</span>
            <span>Agentless Linux Server Inventory &amp; Vault</span>
          </div>

          <div className="flex items-center gap-6">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
            <Link to="/login" className="hover:text-white transition-colors">Console Login</Link>
            <Link to="/servers" className="hover:text-white transition-colors">Servers</Link>
          </div>

          <div className="flex items-center gap-2 text-slate-500">
            <span className="h-2 w-2 rounded-full bg-emerald-400 inline-block animate-pulse" />
            <span>Licencia System Active</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default PortalPage;
