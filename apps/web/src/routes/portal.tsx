import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchMe, systemKeys } from "@/lib/queries";
import { CheckoutDialog } from "@/components/checkout-dialog";
import { PortalNav } from "@/components/portal/portal-nav";
import { PortalHero } from "@/components/portal/portal-hero";
import { PortalSandbox } from "@/components/portal/portal-sandbox";
import { PortalBento } from "@/components/portal/portal-bento";
import { PortalPricing } from "@/components/portal/portal-pricing";
import { PortalQuickstartFaq } from "@/components/portal/portal-quickstart-faq";
import { PortalFooter } from "@/components/portal/portal-footer";

export const Route = createFileRoute("/portal")({
  component: PortalPage,
});

export function PortalPage() {
  const { data: me } = useQuery({
    queryKey: systemKeys.me,
    queryFn: fetchMe,
    retry: false,
  });

  const isAuthenticated = !!me?.id;

  // Checkout modal state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<"free" | "pro" | "enterprise">("pro");
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("annual");

  function handleOpenCheckout(plan: "free" | "pro" | "enterprise") {
    setSelectedPlan(plan);
    setCheckoutOpen(true);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 selection:bg-blue-600 selection:text-white font-sans antialiased relative overflow-x-hidden">
      {/* Visual Depth: CSS Dot Matrix Mesh Overlay */}
      <div className="pointer-events-none fixed inset-0 z-0 opacity-20 [background-image:radial-gradient(#38bdf8_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000_70%,transparent_100%)]" />

      {/* Ambient Gradient Glow Spheres */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 h-[550px] w-[1100px] rounded-full bg-[radial-gradient(circle_at_center,rgba(37,99,235,0.22),transparent_70%)] blur-[100px]" />
        <div className="absolute top-[850px] -left-48 h-[600px] w-[600px] rounded-full bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.14),transparent_70%)] blur-[110px]" />
        <div className="absolute top-[1900px] -right-48 h-[650px] w-[650px] rounded-full bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.16),transparent_70%)] blur-[120px]" />
      </div>

      {/* Floating Glassmorphic Pill Navbar */}
      <PortalNav
        isAuthenticated={isAuthenticated}
        userName={me?.name}
        onOpenCheckout={handleOpenCheckout}
      />

      {/* Hero Section */}
      <PortalHero onOpenCheckout={handleOpenCheckout} />

      {/* Interactive Workstation Demo Sandbox */}
      <div className="container mx-auto max-w-6xl px-4 sm:px-6">
        <PortalSandbox onOpenCheckout={handleOpenCheckout} />
      </div>

      {/* Bento Grid Features & Architecture Pipeline */}
      <PortalBento />

      {/* Licencia Pricing Section & Matrix */}
      <PortalPricing
        billingCycle={billingCycle}
        setBillingCycle={setBillingCycle}
        onOpenCheckout={handleOpenCheckout}
      />

      {/* Quickstart, Testimonials, & FAQ */}
      <PortalQuickstartFaq />

      {/* Bottom CTA Banner & Developer Footer */}
      <PortalFooter onOpenCheckout={handleOpenCheckout} />

      {/* Embedded Pre-Auth & Checkout Modal */}
      <CheckoutDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        initialPlan={selectedPlan}
        initialBillingCycle={billingCycle}
      />
    </div>
  );
}

export default PortalPage;
