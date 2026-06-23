import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { fetchPreferences, updatePreferences } from "@/lib/queries";
import { toast } from "sonner";
import { Bell } from "lucide-react";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_auth/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Manage your notification preferences</p>
      </div>
      <NotificationPreferencesSection />
    </div>
  );
}

function NotificationPreferencesSection() {
  const { data: session } = authClient.useSession();
  // @ts-expect-error - role is injected by admin plugin
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
    <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md p-4 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Bell className="h-4 w-4" />
        <span className="font-medium text-sm">Email Notifications</span>
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
