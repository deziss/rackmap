import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api";
import { fetchMe, systemKeys, licenseKeys } from "@/lib/queries";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  ShieldCheck,
  CheckCircle2,
  Copy,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Lock,
  CreditCard,
  Sparkles,
  Zap,
  Eye,
  EyeOff,
  Check,
  ExternalLink,
} from "lucide-react";
import type {
  CheckoutSessionResponse,
  CheckoutResult,
} from "@inv/shared";

interface CheckoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPlan?: "free" | "pro" | "enterprise";
  initialBillingCycle?: "monthly" | "annual";
  onSuccess?: (result: CheckoutResult) => void;
}

export function CheckoutDialog({
  open,
  onOpenChange,
  initialPlan = "pro",
  initialBillingCycle = "annual",
  onSuccess,
}: CheckoutDialogProps) {
  const qc = useQueryClient();

  // Active user query
  const { data: me, refetch: refetchMe } = useQuery({
    queryKey: systemKeys.me,
    queryFn: fetchMe,
    retry: false,
  });

  const isAuthenticated = !!me?.id;

  // Plan state
  const [planId, setPlanId] = useState<"free" | "pro" | "enterprise">(initialPlan);
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">(initialBillingCycle);
  const [company, setCompany] = useState("");

  // Stepper state: "auth" | "review" | "payment" | "success"
  const [step, setStep] = useState<"auth" | "review" | "payment" | "success">("review");

  // Auth tab: "signup" | "signin"
  const [authTab, setAuthTab] = useState<"signup" | "signin">("signup");
  // Self-registration is opt-in (ALLOW_SELF_SIGNUP). When it is off, checkout
  // has to start from an existing account instead of offering a form that fails.
  const [allowSelfSignup, setAllowSelfSignup] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/public/config", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cancelled && cfg && typeof cfg.allowSelfSignup === "boolean") {
          setAllowSelfSignup(cfg.allowSelfSignup);
          if (!cfg.allowSelfSignup) setAuthTab("signin");
        }
      })
      .catch(() => {
        /* leave the default alone if the flag cannot be read */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);

  // Payment form state
  const [cardholderName, setCardholderName] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [cardExpiry, setCardExpiry] = useState("");
  const [cardCvc, setCardCvc] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"card" | "razorpay">("card");
  const [isProcessing, setIsProcessing] = useState(false);

  // Session & Result
  const [session, setSession] = useState<CheckoutSessionResponse | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<CheckoutResult | null>(null);
  const [isActivatingKey, setIsActivatingKey] = useState(false);
  const [keyActivated, setKeyActivated] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  // Synchronize initial selections when opened
  useEffect(() => {
    if (open) {
      setPlanId(initialPlan);
      setBillingCycle(initialBillingCycle);
      if (!isAuthenticated) {
        setStep("auth");
      } else {
        setStep("review");
        setCardholderName(me?.name || "");
      }
    }
  }, [open, initialPlan, initialBillingCycle, isAuthenticated, me]);

  // Step 1 Auth handler: Sign Up
  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setAuthLoading(true);
    try {
      const { error } = await authClient.signUp.email({
        name: authName,
        email: authEmail,
        password: authPassword,
      });

      if (error) {
        toast.error(error.message || "Registration failed");
        return;
      }

      toast.success("Account created successfully!");
      await refetchMe();
      await qc.invalidateQueries({ queryKey: systemKeys.me });
      setCardholderName(authName);
      setStep("review");
    } catch {
      toast.error("Registration error. Please check credentials.");
    } finally {
      setAuthLoading(false);
    }
  }

  // Step 1 Auth handler: Sign In
  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setAuthLoading(true);
    try {
      const { error } = await authClient.signIn.email({
        email: authEmail,
        password: authPassword,
      });

      if (error) {
        toast.error(error.message || "Sign in failed");
        return;
      }

      toast.success("Signed in successfully!");
      const updated = await refetchMe();
      await qc.invalidateQueries({ queryKey: systemKeys.me });
      setCardholderName(updated.data?.name || "");
      setStep("review");
    } catch {
      toast.error("Invalid email or password");
    } finally {
      setAuthLoading(false);
    }
  }

  // Create checkout session on backend
  async function handleProceedToPayment() {
    setIsProcessing(true);
    try {
      const sess = await apiFetch<CheckoutSessionResponse>("/api/v1/checkout/session", {
        method: "POST",
        body: JSON.stringify({
          planId,
          billingCycle,
          company: company || undefined,
        }),
      });

      setSession(sess);

      // If free plan, complete immediately without asking for card
      if (sess.amount === 0) {
        await handleExecuteComplete(sess.sessionId, "free");
      } else {
        setStep("payment");
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to initiate checkout session");
    } finally {
      setIsProcessing(false);
    }
  }

  // Complete checkout & issue license
  async function handleExecuteComplete(sessionId: string, method: "card" | "razorpay" | "free") {
    setIsProcessing(true);
    try {
      const res = await apiFetch<CheckoutResult>("/api/v1/checkout/complete", {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          paymentMethod: method,
          paymentReference: method === "card" ? `card_tx_${Date.now()}` : undefined,
          cardNumberLast4: method === "card" ? cardNumber.slice(-4) || "4242" : undefined,
          autoActivate: true,
        }),
      });

      setCheckoutResult(res);
      setKeyActivated(res.activated);
      setStep("success");
      toast.success(res.message || "Subscription activated!");

      // Refresh system status queries
      await qc.invalidateQueries({ queryKey: licenseKeys.all });
      await qc.invalidateQueries({ queryKey: systemKeys.me });

      if (onSuccess) {
        onSuccess(res);
      }
    } catch (e: any) {
      toast.error(e.message || "Payment processing failed");
    } finally {
      setIsProcessing(false);
    }
  }

  // Quick helper to fill test card credentials
  function fillTestCard() {
    setCardNumber("4242 4242 4242 4242");
    setCardExpiry("12/28");
    setCardCvc("888");
    setCardholderName(me?.name || "DevOps Administrator");
    toast.info("Filled with valid test card credentials (4242)");
  }

  // Copy key to clipboard
  function handleCopyKey() {
    if (!checkoutResult?.licenseKey) return;
    navigator.clipboard.writeText(checkoutResult.licenseKey);
    setCopiedKey(true);
    toast.success("Licencia License Key copied to clipboard!");
    setTimeout(() => setCopiedKey(false), 2000);
  }

  // Manual 1-click activate button if not already activated
  async function handleActivateNow() {
    if (!checkoutResult?.licenseKey) return;
    setIsActivatingKey(true);
    try {
      await apiFetch("/api/v1/license/activate", {
        method: "POST",
        body: JSON.stringify({ key: checkoutResult.licenseKey }),
      });
      setKeyActivated(true);
      toast.success("Instance successfully upgraded to " + checkoutResult.tier.toUpperCase() + " tier!");
      await qc.invalidateQueries({ queryKey: licenseKeys.all });
      await qc.invalidateQueries({ queryKey: systemKeys.me });
    } catch (e: any) {
      toast.error(e.message || "Activation failed");
    } finally {
      setIsActivatingKey(false);
    }
  }

  // Calculate pricing values
  const isAnnual = billingCycle === "annual";
  const unitPrice = planId === "enterprise" ? (isAnnual ? 199 : 249) : planId === "pro" ? (isAnnual ? 31 : 39) : 0;
  const totalPrice = isAnnual ? unitPrice * 12 : unitPrice;
  const maxServersText = planId === "enterprise" ? "Unlimited Servers" : planId === "pro" ? "Up to 100 Servers" : "Up to 10 Servers";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 overflow-hidden bg-slate-950 border-white/10 text-slate-100 shadow-2xl shadow-blue-950/60 sm:rounded-2xl">
        {/* Step Indicator Header */}
        <div className="border-b border-white/10 bg-slate-900/80 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white shadow-md shadow-blue-600/30">
              <Sparkles className="h-4.5 w-4.5" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold text-white tracking-tight">
                {step === "auth" && "Sign Up or Sign In to Checkout"}
                {step === "review" && "Review Subscription Plan"}
                {step === "payment" && "Complete Payment"}
                {step === "success" && "Subscription & License Confirmed"}
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-400">
                {step === "auth" && "Every subscription is securely linked to your verified account"}
                {step === "review" && "Licencia-powered tiered access with zero agent overhead"}
                {step === "payment" && "Secure 256-bit encrypted checkout via Licencia Gateway"}
                {step === "success" && "Instant deployment and local node capacity upgrade"}
              </DialogDescription>
            </div>
          </div>

          <Badge variant="outline" className="border-blue-500/30 text-blue-400 text-[10px] uppercase font-mono px-2 py-0.5">
            Licencia
          </Badge>
        </div>

        {/* ================= STEP 1: AUTHENTICATION / SIGN UP ================= */}
        {step === "auth" && (
          <div className="p-6 space-y-5">
            {/* Tabs for Sign Up vs Sign In */}
            <div
              className={`grid ${allowSelfSignup ? "grid-cols-2" : "grid-cols-1"} rounded-xl bg-slate-900 p-1 border border-white/10 text-xs font-semibold`}
            >
              {allowSelfSignup && (
                <button
                  type="button"
                  onClick={() => setAuthTab("signup")}
                  className={`py-2 rounded-lg transition-all ${
                    authTab === "signup"
                      ? "bg-blue-600 text-white shadow-md shadow-blue-600/20"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  Create Account (Sign Up)
                </button>
              )}
              <button
                type="button"
                onClick={() => setAuthTab("signin")}
                className={`py-2 rounded-lg transition-all ${
                  authTab === "signin"
                    ? "bg-blue-600 text-white shadow-md shadow-blue-600/20"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Sign In to Existing Account
              </button>
            </div>

            {/* Selected Plan Summary Banner */}
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3.5 flex items-center justify-between text-xs">
              <div>
                <span className="font-semibold text-blue-300 block">
                  Selected Plan: {planId.toUpperCase()} Tier ({maxServersText})
                </span>
                <span className="text-slate-400 text-[11px]">
                  {totalPrice === 0 ? "Free Community License" : `$${totalPrice} / ${billingCycle}`}
                </span>
              </div>
              <Badge variant="outline" className="border-blue-500/40 text-blue-400 text-[10px]">
                Pre-Checkout Gate
              </Badge>
            </div>

            {/* Form */}
            <form onSubmit={authTab === "signup" && allowSelfSignup ? handleSignUp : handleSignIn} className="space-y-4 text-xs">
              {authTab === "signup" && allowSelfSignup && (
                <div className="space-y-1.5">
                  <Label htmlFor="authName" className="text-slate-300">Full Name</Label>
                  <Input
                    id="authName"
                    type="text"
                    required
                    placeholder="Alex Rivera"
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    disabled={authLoading}
                    className="bg-slate-900/80 border-white/10 text-white text-xs h-9"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="authEmail" className="text-slate-300">Work Email Address</Label>
                <Input
                  id="authEmail"
                  type="email"
                  required
                  placeholder="alex@company.com"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  disabled={authLoading}
                  className="bg-slate-900/80 border-white/10 text-white text-xs h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="authPassword" className="text-slate-300">Password</Label>
                <div className="relative">
                  <Input
                    id="authPassword"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={8}
                    placeholder="••••••••"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    disabled={authLoading}
                    className="bg-slate-900/80 border-white/10 text-white text-xs h-9 pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                disabled={authLoading}
                className="w-full h-10 bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow-lg shadow-blue-600/30 gap-2 mt-2"
              >
                {authLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {authTab === "signup" ? "Creating Account…" : "Authenticating…"}
                  </>
                ) : (
                  <>
                    {authTab === "signup" ? "Create Account & Proceed to Payment" : "Sign In & Continue"}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          </div>
        )}

        {/* ================= STEP 2: PLAN & ORDER REVIEW ================= */}
        {step === "review" && (
          <div className="p-6 space-y-5">
            {/* Authenticated User Banner */}
            <div className="rounded-xl border border-white/10 bg-slate-900/70 p-3 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-full bg-blue-600/30 border border-blue-500/40 flex items-center justify-center text-blue-400 font-bold text-xs">
                  {me?.name?.slice(0, 1) || "U"}
                </div>
                <div>
                  <span className="font-semibold text-white block">{me?.name}</span>
                  <span className="text-slate-400 text-[11px]">{me?.email}</span>
                </div>
              </div>
              <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 text-[10px] bg-emerald-500/10">
                Verified Account
              </Badge>
            </div>

            {/* Plan Selector Grid */}
            <div className="grid grid-cols-3 gap-2.5">
              {[
                { id: "free", name: "Community", price: 0, servers: "10 Servers" },
                { id: "pro", name: "Professional", price: isAnnual ? 31 : 39, servers: "100 Servers", pop: true },
                { id: "enterprise", name: "Enterprise", price: isAnnual ? 199 : 249, servers: "Unlimited" },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPlanId(p.id as any)}
                  className={`p-3 rounded-xl text-left border transition-all relative ${
                    planId === p.id
                      ? "border-blue-500 bg-blue-600/15 ring-1 ring-blue-500"
                      : "border-white/10 bg-slate-900/40 hover:border-white/20"
                  }`}
                >
                  {p.pop && (
                    <span className="absolute -top-2 right-2 text-[9px] bg-blue-600 text-white font-bold px-1.5 py-0.2 rounded-full uppercase">
                      Popular
                    </span>
                  )}
                  <span className="text-xs font-bold text-white block">{p.name}</span>
                  <span className="text-base font-extrabold text-white mt-1 block">
                    ${p.price}
                    <span className="text-[10px] font-normal text-slate-400">/mo</span>
                  </span>
                  <span className="text-[10px] text-slate-400 mt-1 block">{p.servers}</span>
                </button>
              ))}
            </div>

            {/* Billing Cycle Toggle */}
            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-slate-900/50 p-3">
              <span className="text-xs font-medium text-slate-300">Billing Frequency</span>
              <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-white/5">
                <button
                  type="button"
                  onClick={() => setBillingCycle("monthly")}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                    billingCycle === "monthly" ? "bg-blue-600 text-white shadow-sm" : "text-slate-400 hover:text-white"
                  }`}
                >
                  Monthly
                </button>
                <button
                  type="button"
                  onClick={() => setBillingCycle("annual")}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1 ${
                    billingCycle === "annual" ? "bg-blue-600 text-white shadow-sm" : "text-slate-400 hover:text-white"
                  }`}
                >
                  Annual
                  <span className="bg-emerald-500/20 text-emerald-400 text-[9px] px-1 py-0.2 rounded font-bold">
                    -20%
                  </span>
                </button>
              </div>
            </div>

            {/* Organization Name (Optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="company" className="text-xs text-slate-300">Company / Organization (Optional)</Label>
              <Input
                id="company"
                type="text"
                placeholder="Acme Infrastructure Corp"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="bg-slate-900/80 border-white/10 text-white text-xs h-9"
              />
            </div>

            {/* Cost Breakdown */}
            <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3.5 space-y-2 text-xs">
              <div className="flex justify-between text-slate-300">
                <span>{planId.toUpperCase()} Subscription ({isAnnual ? "12 Months" : "1 Month"})</span>
                <span className="font-mono font-medium">${totalPrice}.00</span>
              </div>
              {isAnnual && totalPrice > 0 && (
                <div className="flex justify-between text-emerald-400 text-[11px]">
                  <span>Annual Billing Discount applied</span>
                  <span>-20%</span>
                </div>
              )}
              <div className="flex justify-between text-slate-400 text-[11px]">
                <span>Estimated Taxes / VAT</span>
                <span>$0.00</span>
              </div>
              <div className="border-t border-white/10 pt-2 flex justify-between font-bold text-white text-sm">
                <span>Total Amount Due</span>
                <span className="text-blue-400 font-mono">${totalPrice}.00 USD</span>
              </div>
            </div>

            {/* CTA */}
            <Button
              onClick={handleProceedToPayment}
              disabled={isProcessing}
              className="w-full h-11 bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow-lg shadow-blue-600/30 gap-2"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating Order…
                </>
              ) : totalPrice === 0 ? (
                <>
                  <Check className="h-4 w-4" />
                  Claim Free Community License
                </>
              ) : (
                <>
                  Proceed to Payment (${totalPrice}.00)
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        )}

        {/* ================= STEP 3: PAYMENT ================= */}
        {step === "payment" && (
          <div className="p-6 space-y-5">
            {/* Header with back button */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep("review")}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Plan Review
              </button>
              <div className="flex items-center gap-1.5 text-xs text-slate-300 font-mono">
                <span>Total:</span>
                <span className="font-bold text-blue-400">${totalPrice}.00 USD</span>
              </div>
            </div>

            {/* Payment Method Selector */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPaymentMethod("card")}
                className={`p-3 rounded-xl border flex items-center gap-2.5 transition-all ${
                  paymentMethod === "card"
                    ? "border-blue-500 bg-blue-600/10 ring-1 ring-blue-500"
                    : "border-white/10 bg-slate-900 hover:border-white/20"
                }`}
              >
                <CreditCard className="h-4 w-4 text-blue-400" />
                <div className="text-left">
                  <span className="text-xs font-semibold text-white block">Credit / Debit Card</span>
                  <span className="text-[10px] text-slate-400">Instant Activation</span>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setPaymentMethod("razorpay")}
                className={`p-3 rounded-xl border flex items-center gap-2.5 transition-all ${
                  paymentMethod === "razorpay"
                    ? "border-blue-500 bg-blue-600/10 ring-1 ring-blue-500"
                    : "border-white/10 bg-slate-900 hover:border-white/20"
                }`}
              >
                <Zap className="h-4 w-4 text-indigo-400" />
                <div className="text-left">
                  <span className="text-xs font-semibold text-white block">Razorpay / UPI</span>
                  <span className="text-[10px] text-slate-400">Licencia Gateway</span>
                </div>
              </button>
            </div>

            {/* Card Form */}
            {paymentMethod === "card" && (
              <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 space-y-3.5 text-xs">
                <div className="flex items-center justify-between pb-1">
                  <span className="text-slate-300 font-medium">Card Information</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={fillTestCard}
                    className="h-7 text-[10px] border-blue-500/30 text-blue-400 hover:bg-blue-500/10 gap-1"
                  >
                    <Sparkles className="h-3 w-3" />
                    Fill Test Card
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cardName" className="text-slate-400">Cardholder Name</Label>
                  <Input
                    id="cardName"
                    value={cardholderName}
                    onChange={(e) => setCardholderName(e.target.value)}
                    placeholder="Jane Doe"
                    className="bg-slate-950 border-white/10 text-white text-xs h-9"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cardNumber" className="text-slate-400">Card Number</Label>
                  <div className="relative">
                    <Input
                      id="cardNumber"
                      value={cardNumber}
                      onChange={(e) => setCardNumber(e.target.value)}
                      placeholder="4242 4242 4242 4242"
                      className="bg-slate-950 border-white/10 text-white text-xs h-9 pr-8 font-mono"
                    />
                    <Lock className="h-3.5 w-3.5 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="cardExpiry" className="text-slate-400">Expiration</Label>
                    <Input
                      id="cardExpiry"
                      value={cardExpiry}
                      onChange={(e) => setCardExpiry(e.target.value)}
                      placeholder="MM/YY"
                      className="bg-slate-950 border-white/10 text-white text-xs h-9 font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cardCvc" className="text-slate-400">CVC</Label>
                    <Input
                      id="cardCvc"
                      value={cardCvc}
                      onChange={(e) => setCardCvc(e.target.value)}
                      placeholder="123"
                      className="bg-slate-950 border-white/10 text-white text-xs h-9 font-mono"
                    />
                  </div>
                </div>
              </div>
            )}

            {paymentMethod === "razorpay" && (
              <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 text-xs space-y-2">
                <span className="font-semibold text-indigo-300 block">Licencia Razorpay Gateway</span>
                <p className="text-slate-400 text-[11px] leading-relaxed">
                  Upon clicking confirm, the Licencia billing module will dispatch the order receipt to Razorpay for instant NetBanking, UPI, or Card capture.
                </p>
              </div>
            )}

            {/* Pay Button */}
            <Button
              onClick={() => session && handleExecuteComplete(session.sessionId, paymentMethod)}
              disabled={isProcessing}
              className="w-full h-11 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold shadow-xl shadow-blue-600/30 gap-2"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Processing Payment &amp; Minting License…
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4" />
                  Authorize &amp; Pay ${totalPrice}.00 USD
                </>
              )}
            </Button>
          </div>
        )}

        {/* ================= STEP 4: SUCCESS / LICENSE KEY FULFILLMENT ================= */}
        {step === "success" && checkoutResult && (
          <div className="p-6 space-y-5 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shadow-xl shadow-emerald-500/20 animate-fade-in">
              <CheckCircle2 className="h-8 w-8" />
            </div>

            <div>
              <h3 className="text-xl font-extrabold text-white tracking-tight">
                Subscription Confirmed!
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Order <span className="font-mono text-slate-300">{checkoutResult.orderId.slice(0, 8)}</span> • Invoice <span className="font-mono text-blue-400">{checkoutResult.invoiceNumber}</span>
              </p>
            </div>

            {/* License Key Box */}
            <div className="rounded-xl border border-white/10 bg-slate-900/90 p-4 text-left space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Your Licencia License Key
                </span>
                <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 text-[10px] bg-emerald-500/10">
                  {checkoutResult.tier.toUpperCase()} TIER
                </Badge>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 font-mono text-xs font-bold text-emerald-300 bg-slate-950 p-2.5 rounded-lg border border-white/5 truncate select-all">
                  {checkoutResult.licenseKey}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCopyKey}
                  className="h-9 border-white/10 text-slate-300 hover:text-white shrink-0 gap-1 text-xs"
                >
                  {copiedKey ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedKey ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>

            {/* Activation Action */}
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 text-left space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4.5 w-4.5 text-blue-400" />
                  <span className="text-xs font-semibold text-white">Local Instance Activation</span>
                </div>
                {keyActivated ? (
                  <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px]">
                    Active on this Server
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
                    Not Yet Activated
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                {keyActivated
                  ? "This RackMap instance has been successfully upgraded! Node quota and feature gates have unlocked immediately."
                  : "Click below to automatically apply this license key to your current RackMap instance without manual entry."}
              </p>

              {!keyActivated && (
                <Button
                  size="sm"
                  onClick={handleActivateNow}
                  disabled={isActivatingKey}
                  className="w-full h-9 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs gap-1.5"
                >
                  {isActivatingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  Activate License on this Instance
                </Button>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="border-white/10 text-xs text-slate-300 hover:text-white"
              >
                Close Window
              </Button>
              <a href="/servers">
                <Button size="sm" className="bg-blue-600 hover:bg-blue-500 text-white text-xs gap-1.5 font-semibold">
                  Launch Console
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </a>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default CheckoutDialog;
