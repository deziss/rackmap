import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ShieldCheck, Key, Trash2, Plus, User } from "lucide-react";

export const Route = createFileRoute("/_auth/security")({
  component: SecurityPage,
});

interface ApiKey {
  id: string;
  name: string;
  start: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

function SecurityPage() {
  const { data: session } = authClient.useSession();

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Security</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Manage your profile, password, and authentication settings</p>
      </div>
      <ProfileSection user={session?.user ?? null} />
      <ChangePasswordSection />
      <TwoFactorSection enabled={!!(session?.user as { twoFactorEnabled?: boolean })?.twoFactorEnabled} />
      <ApiKeysSection />
    </div>
  );
}

function ProfileSection({ user }: { user: { name?: string; email?: string } | null }) {
  const [name, setName] = useState(user?.name ?? "");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await authClient.updateUser({ name });
      if (error) throw new Error(error.message);
      toast.success("Profile updated");
    } catch (err: unknown) {
      toast.error((err as Error).message ?? "Failed to update profile");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md p-4 space-y-3">
      <div className="flex items-center gap-2">
        <User className="h-4 w-4" />
        <span className="font-medium text-sm">Profile</span>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Email (contact admin to change)</Label>
          <Input value={user?.email ?? ""} disabled className="h-8 text-sm bg-muted/30" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Display Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm" required />
        </div>
        <Button size="sm" type="submit" disabled={loading}>{loading ? "Saving…" : "Update Profile"}</Button>
      </form>
    </div>
  );
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await authClient.changePassword({ currentPassword, newPassword });
      if (error) throw new Error(error.message);
      toast.success("Password changed");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err: unknown) {
      toast.error((err as Error).message ?? "Failed to change password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Key className="h-4 w-4" />
        <span className="font-medium text-sm">Change Password</span>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Current Password</Label>
          <Input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="h-8 text-sm"
            autoComplete="current-password"
            required
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">New Password (min. 8 chars)</Label>
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-8 text-sm"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        <Button size="sm" type="submit" disabled={loading}>{loading ? "Saving…" : "Change Password"}</Button>
      </form>
    </div>
  );
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const [step, setStep] = useState<"idle" | "setup" | "verify" | "disable">("idle");
  const [qrUri, setQrUri] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function startEnroll() {
    setLoading(true);
    try {
      // Get TOTP URI first (requires password — empty string works if password auth doesn't require re-entry)
      const uriRes = await authClient.twoFactor.getTotpUri({ password: "" });
      if (uriRes.data?.totpURI) {
        setQrUri(uriRes.data.totpURI);
        setStep("setup");
      } else {
        toast.error("Could not get TOTP URI");
      }
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function verifyEnroll() {
    setLoading(true);
    try {
      await authClient.twoFactor.verifyTotp({ code: totpCode });
      toast.success("2FA enabled");
      setStep("idle");
      setTotpCode("");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function disable() {
    setLoading(true);
    try {
      await authClient.twoFactor.disable({ password: "" });
      toast.success("2FA disabled");
      setStep("idle");
      setTotpCode("");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" />
        <span className="font-medium text-sm">Two-Factor Authentication</span>
        <Badge variant={enabled ? "default" : "secondary"} className="text-xs ml-auto">
          {enabled ? "Enabled" : "Disabled"}
        </Badge>
      </div>

      {step === "idle" && !enabled && (
        <Button size="sm" onClick={startEnroll} disabled={loading}>
          {loading ? "Loading…" : "Enable 2FA"}
        </Button>
      )}

      {step === "idle" && enabled && (
        <Button size="sm" variant="destructive" onClick={() => setStep("disable")}>
          Disable 2FA
        </Button>
      )}

      {step === "setup" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Scan this QR code in your authenticator app:</p>
          {qrUri && (
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrUri)}`}
              alt="TOTP QR Code"
              className="rounded border"
              width={180}
              height={180}
            />
          )}
          <p className="text-xs text-muted-foreground break-all font-mono">{qrUri}</p>
          <div className="flex gap-2">
            <Input
              placeholder="Enter 6-digit code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              className="h-8 w-36 text-sm"
              maxLength={6}
            />
            <Button size="sm" onClick={verifyEnroll} disabled={loading || totpCode.length < 6}>
              {loading ? "Enabling…" : "Enable 2FA"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setStep("idle")}>Cancel</Button>
          </div>
        </div>
      )}

      {step === "disable" && (
        <div className="flex gap-2 items-center">
          <Input
            placeholder="Enter 6-digit code to confirm"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            className="h-8 w-52 text-sm"
            maxLength={6}
          />
          <Button size="sm" variant="destructive" onClick={disable} disabled={loading || totpCode.length < 6}>
            {loading ? "…" : "Confirm"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setStep("idle")}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadKeys() {
    if (loaded) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/api-keys");
      if (!res.ok) throw new Error(await res.text());
      setKeys(await res.json() as ApiKey[]);
      setLoaded(true);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function createKey() {
    if (!newKeyName.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = await res.json() as { key: string } & ApiKey;
      setNewKeyValue(created.key);
      setNewKeyName("");
      const listRes = await fetch("/api/v1/api-keys");
      setKeys(await listRes.json() as ApiKey[]);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function deleteKey(id: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setKeys((k) => k.filter((x) => x.id !== id));
      toast.success("API key deleted");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Key className="h-4 w-4" />
        <span className="font-medium text-sm">API Keys</span>
        {!loaded && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={loadKeys} disabled={loading}>
            {loading ? "Loading…" : "Load"}
          </Button>
        )}
      </div>

      {newKeyValue && (
        <div className="rounded border bg-muted p-3 text-xs">
          <p className="font-medium mb-1 text-green-700 dark:text-green-400">Copy this key — shown only once:</p>
          <code className="break-all">{newKeyValue}</code>
          <Button size="sm" variant="outline" className="mt-2 h-6 text-xs" onClick={() => { navigator.clipboard.writeText(newKeyValue); toast.success("Copied"); }}>Copy</Button>
        </div>
      )}

      {loaded && (
        <>
          <div className="flex gap-2">
            <Input
              placeholder="Key name…"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              className="h-8 text-sm"
            />
            <Button size="sm" onClick={createKey} disabled={loading || !newKeyName.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Create
            </Button>
          </div>

          {keys.length === 0 && <p className="text-xs text-muted-foreground">No API keys</p>}
          <div className="space-y-1">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 font-medium">{k.name}</span>
                <span className="text-xs text-muted-foreground font-mono">{k.start}…</span>
                <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => deleteKey(k.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
