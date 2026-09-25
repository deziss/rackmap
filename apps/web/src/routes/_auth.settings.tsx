import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import {
  fetchPreferences,
  updatePreferences,
  fetchVaultStatus,
  unlockVaultGlobal,
  lockVaultGlobal,
  resetVault,
  vaultKeys,
  fetchLicenseStatus,
  activateLicense,
  deactivateLicense,
  licenseKeys,
} from "@/lib/queries";
import { toast } from "sonner";
import { Bell, ShieldCheck, ShieldAlert, KeyRound, Lock, Unlock, Eye, EyeOff, Loader2, Sparkles, CheckCircle2, Server, Globe } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckoutDialog } from "@/components/checkout-dialog";
import { StatusHistoryCard } from "@/components/status-history-card";
import { Database } from "lucide-react";
import { BillingHistoryCard } from "@/components/billing-history-card";
import { AlertChannelsSection } from "@/components/alerts/alert-channels-section";
import { BellRing } from "lucide-react";

export const Route = createFileRoute("/_auth/settings")({
  component: SettingsPage,
});

type SettingsTab = "subscription" | "notifications" | "vault" | "alerts" | "maintenance";

function SettingsPage() {
  const { data: session } = authClient.useSession();
  const isAdmin = session?.user?.role === "admin";
  const [activeTab, setActiveTab] = useState<SettingsTab>("subscription");
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  return (
    <div className={`space-y-6 ${activeTab === "subscription" || activeTab === "alerts" ? "max-w-5xl" : "max-w-2xl"} pb-12 transition-all`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Manage licensing subscriptions, billing invoices, notifications, and credential vault
          </p>
        </div>

        {/* Modern Tab Switcher */}
        <div className="flex items-center gap-1.5 p-1 bg-muted/60 border rounded-lg text-xs font-medium self-start sm:self-auto">
          <button
            onClick={() => setActiveTab("subscription")}
            className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
              activeTab === "subscription"
                ? "bg-background text-foreground shadow-sm font-semibold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-500" />
            Subscription &amp; Billing
          </button>
          <button
            onClick={() => setActiveTab("notifications")}
            className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
              activeTab === "notifications"
                ? "bg-background text-foreground shadow-sm font-semibold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Bell className="h-3.5 w-3.5 text-blue-500" />
            Notifications
          </button>
          {isAdmin && (
            <button
              onClick={() => setActiveTab("vault")}
              className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
                activeTab === "vault"
                  ? "bg-background text-foreground shadow-sm font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Lock className="h-3.5 w-3.5 text-purple-500" />
              Vault Security
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setActiveTab("alerts")}
              className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
                activeTab === "alerts"
                  ? "bg-background text-foreground shadow-sm font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <BellRing className="h-3.5 w-3.5 text-amber-500" />
              Alerts
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setActiveTab("maintenance")}
              className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
                activeTab === "maintenance"
                  ? "bg-background text-foreground shadow-sm font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Database className="h-3.5 w-3.5 text-sky-500" />
              Maintenance
            </button>
          )}
        </div>
      </div>

      {activeTab === "subscription" && (
        <div className="space-y-6 animate-fade-in">
          {isAdmin && <LicensingConfigurationSection onUpgradeClick={() => setCheckoutOpen(true)} />}
          <BillingHistoryCard onUpgradeClick={() => setCheckoutOpen(true)} />
        </div>
      )}

      {activeTab === "notifications" && (
        <div className="animate-fade-in">
          <NotificationPreferencesSection />
        </div>
      )}

      {activeTab === "vault" && isAdmin && (
        <div className="animate-fade-in">
          <VaultConfigurationSection />
        </div>
      )}

      {activeTab === "alerts" && isAdmin && (
        <div className="animate-fade-in">
          <AlertChannelsSection />
        </div>
      )}

      {activeTab === "maintenance" && isAdmin && (
        <div className="animate-fade-in">
          <StatusHistoryCard />
        </div>
      )}

      <CheckoutDialog open={checkoutOpen} onOpenChange={setCheckoutOpen} />
    </div>
  );
}

function VaultConfigurationSection() {
  const qc = useQueryClient();
  const { data: vaultStatus, isLoading } = useQuery({
    queryKey: vaultKeys.status,
    queryFn: fetchVaultStatus,
  });

  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [persistToEnv, setPersistToEnv] = useState(false);
  const [loading, setLoading] = useState(false);

  // Reset mode state
  const [showReset, setShowReset] = useState(false);
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  // Re-keying preserves stored credentials; destroying does not. Default to the
  // safe path and make the destructive one a deliberate choice.
  const [forceDestroy, setForceDestroy] = useState(false);

  const isUnlocked = !!vaultStatus?.isUnlocked;
  const isGlobal = !!vaultStatus?.isGlobalUnlocked;

  async function handleUnlockGlobal(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase.trim()) {
      toast.error("Please enter a vault passphrase");
      return;
    }
    setLoading(true);
    try {
      await unlockVaultGlobal(passphrase, persistToEnv);
      toast.success("Vault unlocked globally! All servers can now decrypt credentials.");
      setPassphrase("");
      qc.invalidateQueries({ queryKey: vaultKeys.status });
    } catch (err: any) {
      toast.error(err.message || "Failed to unlock vault globally");
    } finally {
      setLoading(false);
    }
  }

  async function handleLockGlobal() {
    setLoading(true);
    try {
      await lockVaultGlobal();
      toast.success("Global vault locked");
      qc.invalidateQueries({ queryKey: vaultKeys.status });
    } catch (err: any) {
      toast.error(err.message || "Failed to lock vault");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetVault(e: React.FormEvent) {
    e.preventDefault();
    if (newPassphrase.length < 8) {
      toast.error("Passphrase must be at least 8 characters");
      return;
    }
    if (newPassphrase !== confirmPassphrase) {
      toast.error("Passphrases do not match");
      return;
    }
    if (!forceDestroy && !currentPassphrase) {
      toast.error("Enter the current passphrase, or choose to destroy and re-key");
      return;
    }
    setLoading(true);
    try {
      const res = await resetVault(
        forceDestroy
          ? { newPassphrase, forceDestroy: true }
          : { newPassphrase, currentPassphrase },
      );
      toast.success(
        res.mode === "destroyed"
          ? "Vault re-keyed. Credentials encrypted under the old passphrase must be re-entered."
          : "Master passphrase changed. Existing credentials were preserved.",
      );
      setShowReset(false);
      setNewPassphrase("");
      setConfirmPassphrase("");
      setCurrentPassphrase("");
      setForceDestroy(false);
      qc.invalidateQueries({ queryKey: vaultKeys.status });
    } catch (err: any) {
      toast.error(err.message || "Failed to reset vault");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md p-5 space-y-4 shadow-lg">
      <div className="flex items-center justify-between pb-3 border-b border-border/40">
        <div className="flex items-center gap-2.5">
          <KeyRound className="h-5 w-5 text-primary" />
          <div>
            <h2 className="font-semibold text-base text-foreground">Credential Vault & Encryption</h2>
            <p className="text-xs text-muted-foreground">Manage global passphrase to decrypt server & service passwords system-wide</p>
          </div>
        </div>

        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : isUnlocked ? (
          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 gap-1 text-xs">
            <ShieldCheck className="h-3.5 w-3.5" />
            {isGlobal ? "Unlocked Globally" : "Unlocked (Session)"}
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1 text-xs">
            <ShieldAlert className="h-3.5 w-3.5" />
            Vault Locked
          </Badge>
        )}
      </div>

      {isUnlocked ? (
        <div className="space-y-3 pt-1">
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs space-y-1 text-emerald-300">
            <p className="font-semibold flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" /> Vault is currently active and unlocked
            </p>
            <p className="text-emerald-400/80">
              Auto-discovery, ATOP, Forensic Logs, and Terminal sessions can automatically decrypt passwords across all servers without prompting.
            </p>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-red-500/30 text-red-400 hover:bg-red-500/10 gap-1.5 text-xs"
              onClick={handleLockGlobal}
              disabled={loading}
            >
              <Lock className="h-3.5 w-3.5" /> Lock Vault Now
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowReset(!showReset)}
            >
              Reset / Change Passphrase
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleUnlockGlobal} className="space-y-3 pt-1">
          <p className="text-xs text-muted-foreground">
            Enter your Master Vault Passphrase to unlock credentials globally for all servers and background probes.
          </p>

          <div className="space-y-2">
            <div className="relative">
              <Input
                type={showPass ? "text" : "password"}
                placeholder="Enter Master Vault Passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="pr-10 bg-background/50 text-sm font-mono"
                autoComplete="current-password"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPass(!showPass)}
                tabIndex={-1}
              >
                {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={persistToEnv}
                onChange={(e) => setPersistToEnv(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer"
              />
              Keep unlocked permanently (save to .env file for auto-unlock on container reboot)
            </label>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" size="sm" className="gap-1.5 text-xs" disabled={loading || !passphrase.trim()}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
              Unlock Globally
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowReset(!showReset)}
            >
              Reset / Re-key Vault
            </Button>
          </div>
        </form>
      )}

      {/* Re-key / Reset Form */}
      {showReset && (
        <div className="mt-4 p-4 border border-destructive/30 rounded-lg bg-destructive/5 space-y-3">
          <div className="flex items-center gap-2 text-destructive font-semibold text-xs">
            <ShieldAlert className="h-4 w-4" />
            <span>Change Master Vault Passphrase</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {forceDestroy
              ? "This mints a brand-new master key. Every credential encrypted under the old passphrase becomes permanently unreadable and must be re-entered. Only use this if the current passphrase is lost."
              : "Enter the current passphrase to re-key in place. Stored credentials are preserved."}
          </p>
          <form onSubmit={handleResetVault} className="space-y-2.5">
            {!forceDestroy && (
              <Input
                type="password"
                placeholder="Current Master Passphrase"
                value={currentPassphrase}
                onChange={(e) => setCurrentPassphrase(e.target.value)}
                className="text-xs font-mono bg-background/50"
              />
            )}
            <Input
              type="password"
              placeholder="New Master Passphrase (min 8 chars)"
              value={newPassphrase}
              onChange={(e) => setNewPassphrase(e.target.value)}
              className="text-xs font-mono bg-background/50"
            />
            <Input
              type="password"
              placeholder="Confirm New Passphrase"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              className="text-xs font-mono bg-background/50"
            />
            <label className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={forceDestroy}
                onChange={(e) => setForceDestroy(e.target.checked)}
                className="accent-destructive"
              />
              <span>I have lost the current passphrase — destroy and re-key</span>
            </label>
            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" size="sm" variant="destructive" className="h-7 text-xs" disabled={loading || !newPassphrase}>
                {forceDestroy ? "Destroy & Re-key Vault" : "Change Passphrase"}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowReset(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function NotificationPreferencesSection() {
  const { data: session } = authClient.useSession();
  const isAdmin = session?.user?.role === "admin";
  
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchPreferences()
      .then(setPrefs)
      .catch(() => toast.error("Failed to load preferences"))
      .finally(() => setLoading(false));
  }, []);

  async function handleToggle(key: string, value: boolean) {
    if (!prefs) return;
    const newPrefs = { ...prefs, [key]: value };
    setPrefs(newPrefs);
    setSaving(true);
    try {
      await updatePreferences({ [key]: value });
      toast.success("Preferences updated");
    } catch (err: unknown) {
      toast.error("Failed to update preferences");
      // Revert on failure
      setPrefs(prefs);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-sm text-muted-foreground p-4">Loading preferences...</div>;
  if (!prefs) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md p-5 space-y-4 shadow-lg">
      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-border/40">
        <Bell className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-semibold text-base text-foreground">Email Notifications</h2>
          <p className="text-xs text-muted-foreground">Choose what system events trigger alert emails</p>
        </div>
      </div>
      
      <div className="space-y-3">
        <PrefToggle label="New Server Added" prefKey="newServerAdded" val={!!prefs.newServerAdded} onChange={handleToggle} disabled={saving} />
        <PrefToggle label="Server Up/Down Status" prefKey="serverUpDown" val={!!prefs.serverUpDown} onChange={handleToggle} disabled={saving} />
        <PrefToggle label="GPU Count Changed" prefKey="gpuCountChanged" val={!!prefs.gpuCountChanged} onChange={handleToggle} disabled={saving} />
        <PrefToggle label="Disk Unmounted" prefKey="diskUnmounted" val={!!prefs.diskUnmounted} onChange={handleToggle} disabled={saving} />
        <PrefToggle label="Disk Full" prefKey="diskFull" val={!!prefs.diskFull} onChange={handleToggle} disabled={saving} />
        <PrefToggle label="RAM Full" prefKey="ramFull" val={!!prefs.ramFull} onChange={handleToggle} disabled={saving} />
        <PrefToggle label="High CPU Usage" prefKey="highCpu" val={!!prefs.highCpu} onChange={handleToggle} disabled={saving} />
        {isAdmin && (
          <PrefToggle label="User Registered (Admin Only)" prefKey="userRegistered" val={!!prefs.userRegistered} onChange={handleToggle} disabled={saving} />
        )}
      </div>
    </div>
  );
}

function PrefToggle({ label, prefKey, val, onChange, disabled }: { label: string, prefKey: string, val: boolean, onChange: (k: string, v: boolean) => void, disabled: boolean }) {
  return (
    <div className="flex items-center justify-between p-2 hover:bg-muted/30 rounded-md transition-colors">
      <Label className="text-sm font-normal cursor-pointer flex-1" htmlFor={prefKey}>{label}</Label>
      <input 
        id={prefKey} 
        type="checkbox" 
        checked={val} 
        onChange={(e) => onChange(prefKey, e.target.checked)} 
        disabled={disabled}
        className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer disabled:opacity-50"
      />
    </div>
  );
}

// ----------------------------------------------------------------------
// Section: Subscription & Licensing (Licencia)
// ----------------------------------------------------------------------
function LicensingConfigurationSection({ onUpgradeClick }: { onUpgradeClick?: () => void } = {}) {
  const qc = useQueryClient();
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const { data: license, isLoading } = useQuery({
    queryKey: licenseKeys.status(),
    queryFn: fetchLicenseStatus,
  });

  const [licenseKey, setLicenseKey] = useState("");
  const [offlineToken, setOfflineToken] = useState("");
  const [showOffline, setShowOffline] = useState(false);
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  async function handleActivate(e: React.FormEvent) {
    e.preventDefault();
    if (!licenseKey.trim() && !offlineToken.trim()) return;
    setActivating(true);
    try {
      const res = await activateLicense({
        key: licenseKey.trim(),
        offlineToken: offlineToken.trim() || undefined,
      });
      toast.success(`Activated ${res.planName}!`);
      setLicenseKey("");
      setOfflineToken("");
      qc.invalidateQueries({ queryKey: licenseKeys.all });
    } catch (e: any) {
      toast.error(e.message || "Failed to activate license");
    } finally {
      setActivating(false);
    }
  }

  async function handleDeactivate() {
    if (!confirm("Are you sure you want to deactivate this license and return to the Free Community Edition?")) return;
    setDeactivating(true);
    try {
      await deactivateLicense();
      toast.success("License deactivated. Returned to Free Community Edition.");
      qc.invalidateQueries({ queryKey: licenseKeys.all });
    } catch (e: any) {
      toast.error(e.message || "Failed to deactivate license");
    } finally {
      setDeactivating(false);
    }
  }

  const isFree = !license || license.tier === "free";
  const percentUsed = license && license.maxServers > 0
    ? Math.min(100, Math.round((license.serverCount / license.maxServers) * 100))
    : 0;

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow-sm p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between border-b pb-4">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            Subscription & Licensing
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enterprise licensing, node limits, and feature entitlements powered by Licencia
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => onUpgradeClick ? onUpgradeClick() : setCheckoutOpen(true)}
            className="h-7 text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium gap-1.5 shadow-sm"
          >
            <Sparkles className="h-3 w-3 text-blue-200" />
            Upgrade / Checkout
          </Button>
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Badge
            className={
              license?.tier === "enterprise"
                ? "bg-amber-500/20 text-amber-400 border-amber-500/30 uppercase text-[10px]"
                : license?.tier === "pro"
                ? "bg-purple-500/20 text-purple-400 border-purple-500/30 uppercase text-[10px]"
                : "bg-muted text-muted-foreground border-border uppercase text-[10px]"
            }
          >
            {license?.planName || "Free Community"}
          </Badge>
        )}
        </div>
      </div>

      {/* Node Capacity & Utilization */}
      <div className="rounded-lg border bg-muted/20 p-3.5 space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-medium flex items-center gap-1.5 text-foreground">
            <Server className="h-3.5 w-3.5 text-primary" /> Managed Nodes Capacity:
          </span>
          <span className="font-semibold text-foreground">
            {license?.serverCount ?? 0} / {license?.maxServers === -1 ? "Unlimited" : (license?.maxServers ?? 10)} Servers
          </span>
        </div>
        {license?.maxServers !== -1 && (
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden border">
            <div
              className={`h-full transition-all ${percentUsed >= 90 ? "bg-rose-500" : percentUsed >= 70 ? "bg-amber-500" : "bg-primary"}`}
              style={{ width: `${percentUsed}%` }}
            />
          </div>
        )}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{isFree ? "Free Community allows up to 10 servers." : "Active subscription allowance."}</span>
          <span>{percentUsed}% Quota Utilized</span>
        </div>
      </div>

      {/* Feature Entitlements Chips */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-foreground block">Active Feature Entitlements:</span>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            { key: "hardware_discovery", label: "Hardware Auto-Discovery" },
            { key: "atop_history", label: "ATOP Spikes Timeline & Replay" },
            { key: "remote_os_users", label: "Remote OS Users & Sudoers" },
            { key: "auto_update", label: "Automated OS Patching" },
            { key: "multi_channel_alerts", label: "Multi-Channel Alerting" },
            { key: "remote_cron", label: "Remote Cron Job Editor" },
            { key: "runbooks", label: "Runbooks & Fleet Exec" },
            { key: "service_manager", label: "systemd Service Manager" },
            { key: "patch_management", label: "Fleet Patch Management" },
            { key: "drift_detection", label: "Drift Detection" },
            { key: "access_expiry", label: "Time-boxed Access" },
          ].map((feat) => {
            const isEnabled = !isFree && !!license?.features?.[feat.key];
            return (
              <div
                key={feat.key}
                className={`p-2 rounded-md border text-[11px] flex items-center justify-between ${
                  isEnabled ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300" : "bg-muted/30 text-muted-foreground opacity-75"
                }`}
              >
                <span>{feat.label}</span>
                {isEnabled ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 border-muted-foreground/30 text-muted-foreground">PRO</Badge>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Hardware Fingerprint */}
      {license?.hardwareId && (
        <div className="text-[11px] text-muted-foreground flex items-center justify-between border-t pt-2 font-mono">
          <span>Hardware Fingerprint:</span>
          <span className="bg-muted px-1.5 py-0.5 rounded border">{license.hardwareId}</span>
        </div>
      )}

      {/* Activation Form */}
      <form onSubmit={handleActivate} className="space-y-3 border-t pt-3">
        <div className="space-y-1.5">
          <Label className="text-xs">
            {isFree ? "Activate Licencia License Key" : "Change / Upgrade License Key"}
          </Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="LIC-XXXX-XXXX-XXXX-XXXX"
                className="pl-8 text-xs font-mono"
                disabled={activating || deactivating}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={(!licenseKey.trim() && !offlineToken.trim()) || activating}
              className="gap-1.5 text-xs shrink-0"
            >
              {activating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Activate
            </Button>
          </div>
        </div>

        {/* Optional Offline Token Input */}
        <div>
          <button
            type="button"
            onClick={() => setShowOffline(!showOffline)}
            className="text-[11px] text-primary hover:underline flex items-center gap-1"
          >
            <Globe className="h-3 w-3" />
            {showOffline ? "Hide Offline Token Field" : "Air-gapped deployment? Paste offline lease token"}
          </button>
          {showOffline && (
            <div className="mt-2 space-y-1">
              <Input
                type="text"
                value={offlineToken}
                onChange={(e) => setOfflineToken(e.target.value)}
                placeholder="Paste signed offline license token (ey...)"
                className="text-xs font-mono"
                disabled={activating || deactivating}
              />
            </div>
          )}
        </div>

        {/* Deactivate button if currently active */}
        {!isFree && (
          <div className="pt-2 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDeactivate}
              disabled={deactivating || activating}
              className="text-xs border-rose-500/30 text-rose-400 hover:bg-rose-500/10"
            >
              {deactivating ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Deactivate License (Return to Free)
            </Button>
          </div>
        )}
      </form>

      <CheckoutDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        initialPlan="pro"
      />
    </div>
  );
}
