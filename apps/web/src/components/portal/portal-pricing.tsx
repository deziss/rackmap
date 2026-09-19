import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

interface PortalPricingProps {
  billingCycle: "monthly" | "annual";
  setBillingCycle: (cycle: "monthly" | "annual") => void;
  onOpenCheckout: (plan: "free" | "pro" | "enterprise") => void;
}

export function PortalPricing({ billingCycle, setBillingCycle, onOpenCheckout }: PortalPricingProps) {
  const plans = [
    {
      id: "free" as const,
      name: "Community Edition",
      badge: "Open Source Core",
      badgeVariant: "secondary" as const,
      priceMonthly: 0,
      priceAnnual: 0,
      description: "For homelabs, independent developers, and small test environments.",
      serverLimit: "Up to 10 Managed Servers",
      features: [
        "10 Linux nodes maximum",
        "Agentless SSH discovery & telemetry",
        "Zero-Knowledge WebCrypto Vault (AES-256)",
        "Live system status & TCP ping probes",
        "Standard metrics (CPU, RAM, Disk, Net)",
        "Single-user or team viewer access",
      ],
      missing: [
        "Historical ATOP time-machine replay",
        "Remote OS user & sudoers audit",
        "Automated daily background hardware sync",
        "Multi-channel alert webhooks",
        "Air-gapped offline Ed25519 lease token",
      ],
      cta: "Get Started Free",
      highlighted: false,
    },
    {
      id: "pro" as const,
      name: "Professional",
      badge: "Most Popular",
      badgeVariant: "default" as const,
      priceMonthly: 39,
      priceAnnual: 31,
      description: "Engineered for growing engineering squads, DevOps teams, and production clusters.",
      serverLimit: "Up to 100 Managed Servers",
      features: [
        "Up to 100 Linux nodes",
        "Everything in Community, plus:",
        "ATOP kernel metric historical replay (30 days)",
        "Remote OS users, sudoers & groups discovery",
        "Automated daily background hardware sync",
        "SSL certificate auto-expiry alarms",
        "Multi-channel alert dispatch (Discord, Slack, Webhooks)",
        "Priority email & ticket support",
        "Licencia digital key activation",
      ],
      missing: [
        "Offline air-gapped cryptographic validation",
        "Dedicated enterprise SLA & custom discovery",
      ],
      cta: "Upgrade to Pro",
      highlighted: true,
    },
    {
      id: "enterprise" as const,
      name: "Enterprise",
      badge: "High Security & Scale",
      badgeVariant: "outline" as const,
      priceMonthly: 249,
      priceAnnual: 199,
      description: "For mission-critical infrastructure, defense networks, and air-gapped environments.",
      serverLimit: "Unlimited Nodes & Users",
      features: [
        "Unlimited servers & infinite scalability",
        "Everything in Professional, plus:",
        "Air-gapped offline Licencia activation (Ed25519)",
        "365-day ATOP & audit trail retention",
        "Role-Based Access Control (RBAC) & SSO",
        "Audit log streaming to SIEM (Datadog, Splunk)",
        "Custom SSH discovery modules",
        "Dedicated account architect & 99.9% SLA",
      ],
      missing: [],
      cta: "Contact Enterprise Sales",
      highlighted: false,
    },
  ];

  const comparisonCategories = [
    {
      category: "Fleet Capacity & Scaling",
      items: [
        { feature: "Managed Server Nodes", free: "Up to 10", pro: "Up to 100", ent: "Unlimited" },
        { feature: "Agentless SSH Architecture", free: true, pro: true, ent: true },
        { feature: "Zero-Knowledge AES-256-GCM Vault", free: true, pro: true, ent: true },
        { feature: "Multi-User Access & RBAC", free: "3 Users", pro: "15 Users", ent: "Unlimited" },
        { feature: "Self-Hosted Docker Deployment", free: true, pro: true, ent: true },
      ],
    },
    {
      category: "Telemetry & Forensics Engine",
      items: [
        { feature: "Hardware & Network Discovery", free: "Basic", pro: "Deep (lshw/dmidecode)", ent: "Full + Custom" },
        { feature: "Real-time Metrics Polling", free: "5 Minutes", pro: "1 Minute", ent: "Custom (10s)" },
        { feature: "Historical ATOP Spike Replay", free: false, pro: "30 Days", ent: "365 Days" },
        { feature: "Remote OS Users & Sudo Audit", free: false, pro: true, ent: true },
        { feature: "Automated Daily Hardware Refresh", free: false, pro: true, ent: true },
      ],
    },
    {
      category: "Security & Licensing (Licencia)",
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
    <section id="pricing" className="py-24 border-t border-white/10 bg-slate-950 relative overflow-hidden">
      <div className="container mx-auto max-w-6xl px-4 sm:px-6">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-xs px-3.5 py-1 mb-3">
            Licencia Subscription Tiers
          </Badge>
          <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">
            Simple, Predictable Infrastructure Pricing
          </h2>
          <p className="mt-3 text-sm sm:text-base text-slate-400">
            Start free with Community edition. Upgrade when your fleet scales or when you need 30-day ATOP historical replay and air-gapped leases.
          </p>

          {/* Billing Cycle Switcher */}
          <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-white/15 bg-slate-900/90 p-1.5 backdrop-blur-md">
            <button
              type="button"
              onClick={() => setBillingCycle("monthly")}
              className={`rounded-full px-5 py-2 text-xs font-semibold transition-all cursor-pointer ${
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
              className={`rounded-full px-5 py-2 text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
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
                    ? "border-2 border-blue-500 bg-slate-900/95 shadow-2xl shadow-blue-600/25 ring-1 ring-blue-500/50"
                    : "border border-white/10 bg-slate-900/40 hover:border-white/20"
                }`}
              >
                {p.highlighted && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <Badge className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white border-0 px-4 py-1 text-xs font-bold uppercase tracking-wider shadow-lg shadow-blue-500/30">
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
                  <p className="mt-2 text-xs text-slate-300 min-h-[36px] leading-relaxed">{p.description}</p>

                  {/* Price Display */}
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-4xl sm:text-5xl font-extrabold text-white font-mono">${price}</span>
                    <span className="text-xs font-medium text-slate-400">
                      {p.priceMonthly === 0 ? "/ forever" : "/ node group / mo"}
                    </span>
                  </div>
                  {billingCycle === "annual" && p.priceMonthly > 0 && (
                    <p className="text-[11px] text-emerald-400 mt-1 font-medium">
                      Billed annually (${price * 12}/yr) — includes 2 months free
                    </p>
                  )}

                  <div className="mt-4 p-3 rounded-xl bg-white/5 border border-white/5 text-center text-xs font-semibold text-blue-300 font-mono">
                    {p.serverLimit}
                  </div>

                  {/* Feature Bullets */}
                  <div className="mt-6 space-y-3 text-xs">
                    <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">Included Capabilities</p>
                    {p.features.map((feat, idx) => (
                      <div key={idx} className="flex items-start gap-2.5 text-slate-200">
                        <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{feat}</span>
                      </div>
                    ))}
                    {p.missing.map((feat, idx) => (
                      <div key={idx} className="flex items-start gap-2.5 text-slate-400 line-through">
                        <span className="h-4 w-4 shrink-0 text-center font-bold text-slate-600">•</span>
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-8 pt-4 border-t border-white/10">
                  <Button
                    onClick={() => onOpenCheckout(p.id)}
                    className={`w-full h-11 text-xs font-semibold rounded-xl cursor-pointer transition-all ${
                      p.highlighted
                        ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/40"
                        : "border border-white/15 bg-white/5 text-white hover:bg-white/10"
                    }`}
                  >
                    {p.cta}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Full Comparison Matrix */}
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
                  <tr className="bg-white/5">
                    <td colSpan={4} className="py-2.5 px-6 font-bold text-xs uppercase tracking-wider text-blue-300">
                      {cat.category}
                    </td>
                  </tr>
                  {cat.items.map((item, itemIdx) => (
                    <tr key={itemIdx} className="hover:bg-white/5 transition-colors">
                      <td className="py-3 px-6 text-slate-200">{item.feature}</td>
                      <td className="py-3 px-4 text-center">
                        {typeof item.free === "boolean" ? (
                          item.free ? <Check className="h-4 w-4 text-emerald-400 mx-auto" /> : <span className="text-slate-600 font-bold">—</span>
                        ) : (
                          <span className="font-mono text-xs text-slate-300">{item.free}</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {typeof item.pro === "boolean" ? (
                          item.pro ? <Check className="h-4 w-4 text-emerald-400 mx-auto" /> : <span className="text-slate-600 font-bold">—</span>
                        ) : (
                          <span className="font-mono text-xs text-blue-300 font-semibold">{item.pro}</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {typeof item.ent === "boolean" ? (
                          item.ent ? <Check className="h-4 w-4 text-emerald-400 mx-auto" /> : <span className="text-slate-600 font-bold">—</span>
                        ) : (
                          <span className="font-mono text-xs text-indigo-300 font-semibold">{item.ent}</span>
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
  );
}
