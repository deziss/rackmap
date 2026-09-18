import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Lock, Unlock, ShieldAlert, ShieldCheck, Loader2, RotateCcw, ArrowLeft } from "lucide-react";
import { fetchVaultStatus, initVault, unlockVault, lockVault, resetVault, vaultKeys } from "@/lib/queries";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";

interface VaultUnlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function VaultUnlockDialog({ open, onOpenChange, onSuccess }: VaultUnlockDialogProps) {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const isAdmin = session?.user?.role === "admin";

  const [mode, setMode] = useState<"unlock" | "reset">("unlock");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: vaultKeys.status,
    queryFn: fetchVaultStatus,
    enabled: open,
  });

  const unlockMutation = useMutation({
    mutationFn: unlockVault,
    onSuccess: () => {
      toast.success("Security Vault unlocked successfully (active for 30 minutes)");
      queryClient.invalidateQueries({ queryKey: vaultKeys.status });
      setPassphrase("");
      setErrorMsg("");
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err: any) => {
      setErrorMsg(err.message || "Invalid vault passphrase");
    },
  });

  const initMutation = useMutation({
    mutationFn: initVault,
    onSuccess: () => {
      toast.success("Master Vault initialized and unlocked!");
      queryClient.invalidateQueries({ queryKey: vaultKeys.status });
      setPassphrase("");
      setConfirmPassphrase("");
      setErrorMsg("");
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err: any) => {
      setErrorMsg(err.message || "Failed to initialize vault");
    },
  });

  const resetMutation = useMutation({
    mutationFn: resetVault,
    onSuccess: () => {
      toast.success("Master Vault has been reset with new passphrase!");
      queryClient.invalidateQueries({ queryKey: vaultKeys.status });
      setPassphrase("");
      setConfirmPassphrase("");
      setErrorMsg("");
      setMode("unlock");
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err: any) => {
      setErrorMsg(err.message || "Failed to reset vault");
    },
  });

  const lockMutation = useMutation({
    mutationFn: lockVault,
    onSuccess: () => {
      toast.info("Security Vault locked");
      queryClient.invalidateQueries({ queryKey: vaultKeys.status });
      onOpenChange(false);
    },
  });

  const isInitialized = status?.isInitialized ?? true;
  const isUnlocked = status?.isUnlocked ?? false;
  const isEnvUnlocked = status?.isEnvUnlocked ?? false;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    if (!passphrase) {
      setErrorMsg("Passphrase cannot be empty");
      return;
    }

    if (mode === "reset") {
      if (passphrase.length < 8) {
        setErrorMsg("New passphrase must be at least 8 characters long");
        return;
      }
      if (passphrase !== confirmPassphrase) {
        setErrorMsg("Passphrases do not match");
        return;
      }
      resetMutation.mutate(passphrase);
      return;
    }

    if (!isInitialized) {
      if (passphrase.length < 8) {
        setErrorMsg("Passphrase must be at least 8 characters long");
        return;
      }
      if (passphrase !== confirmPassphrase) {
        setErrorMsg("Passphrases do not match");
        return;
      }
      initMutation.mutate(passphrase);
    } else {
      unlockMutation.mutate(passphrase);
    }
  };

  const isPending =
    unlockMutation.isPending || initMutation.isPending || lockMutation.isPending || resetMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setMode("unlock");
          setErrorMsg("");
          setPassphrase("");
          setConfirmPassphrase("");
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              {mode === "reset" ? (
                <RotateCcw className="h-5 w-5 text-amber-500" />
              ) : isUnlocked ? (
                <Unlock className="h-5 w-5 text-emerald-500" />
              ) : (
                <Lock className="h-5 w-5" />
              )}
            </div>
            <div>
              <DialogTitle className="text-lg flex items-center gap-2">
                Credential Vault
                {mode === "reset" ? (
                  <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-xs gap-1">
                    Reset Mode
                  </Badge>
                ) : isUnlocked ? (
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-xs gap-1">
                    <ShieldCheck className="h-3 w-3" /> Unlocked
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-xs gap-1">
                    <ShieldAlert className="h-3 w-3" /> Locked
                  </Badge>
                )}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                {mode === "reset"
                  ? "Re-initialize the master vault key with a new passphrase."
                  : "Zero-knowledge PBKDF2/AES-256 envelope encryption for server credentials."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {statusLoading ? (
          <div className="py-8 flex justify-center items-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : mode === "reset" ? (
          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            <div className="p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-500 dark:text-amber-400 text-xs space-y-1">
              <strong>Admin Recovery Warning:</strong>
              <p>
                Resetting the vault generates a brand new master DEK. Any existing passwords encrypted under the forgotten
                passphrase cannot be decrypted automatically and must be re-entered.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-vault-passphrase" className="text-xs">
                New Master Passphrase (min 8 chars)
              </Label>
              <div className="relative">
                <Input
                  id="new-vault-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter new master passphrase..."
                  className="pr-9 font-mono text-sm"
                  autoFocus
                  required
                />
                <KeyRound className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-new-vault-passphrase" className="text-xs">
                Confirm New Master Passphrase
              </Label>
              <Input
                id="confirm-new-vault-passphrase"
                type="password"
                value={confirmPassphrase}
                onChange={(e) => setConfirmPassphrase(e.target.value)}
                placeholder="Repeat new master passphrase..."
                className="font-mono text-sm"
                required
              />
            </div>

            {errorMsg && (
              <div className="text-xs font-medium text-destructive bg-destructive/10 p-2.5 rounded border border-destructive/20 flex items-center gap-1.5">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <DialogFooter className="flex sm:justify-between items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1 text-xs"
                onClick={() => {
                  setMode("unlock");
                  setErrorMsg("");
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Unlock
              </Button>
              <Button type="submit" variant="destructive" size="sm" disabled={isPending} className="gap-1.5">
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <RotateCcw className="h-3.5 w-3.5" /> Reset Master Vault
              </Button>
            </DialogFooter>
          </form>
        ) : isUnlocked ? (
          <div className="space-y-4 py-2">
            <div className="p-3.5 rounded-lg bg-muted/40 border text-xs space-y-1.5">
              <div className="flex justify-between items-center text-muted-foreground">
                <span>Status:</span>
                <span className="font-semibold text-emerald-500">
                  {isEnvUnlocked ? "Active System Session (via .env)" : "Active In-Memory Session"}
                </span>
              </div>
              {status?.expiresAt ? (
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Auto-locks at:</span>
                  <span className="font-mono">{new Date(status.expiresAt).toLocaleTimeString()}</span>
                </div>
              ) : isEnvUnlocked ? (
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Persisted Unlock:</span>
                  <span className="text-xs text-muted-foreground font-mono">VAULT_PASSPHRASE configured</span>
                </div>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Your session is currently authorized to decrypt passwords, perform privileged SSH operations, and run hardware auto-discovery.
            </p>
            <DialogFooter className="flex sm:justify-between items-center gap-2">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                {isAdmin && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground hover:text-foreground gap-1"
                    onClick={() => {
                      setMode("reset");
                      setErrorMsg("");
                      setPassphrase("");
                      setConfirmPassphrase("");
                    }}
                  >
                    <RotateCcw className="h-3 w-3" /> Reset / Re-key
                  </Button>
                )}
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                disabled={isPending}
                onClick={() => lockMutation.mutate()}
              >
                {lockMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <Lock className="h-3.5 w-3.5" /> Lock Vault Now
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            {!isInitialized ? (
              <div className="p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs">
                <strong>First-time setup:</strong> Set a master vault passphrase. This passphrase will derive the key encrypting all server credentials across the platform.
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Enter the master passphrase to decrypt server passwords and execute remote commands.
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="vault-passphrase" className="text-xs">
                {isInitialized ? "Vault Passphrase" : "Create Master Passphrase"}
              </Label>
              <div className="relative">
                <Input
                  id="vault-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter master passphrase..."
                  className="pr-9 font-mono text-sm"
                  autoFocus
                  required
                />
                <KeyRound className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              </div>
            </div>

            {!isInitialized && (
              <div className="space-y-2">
                <Label htmlFor="confirm-passphrase" className="text-xs">
                  Confirm Master Passphrase
                </Label>
                <Input
                  id="confirm-passphrase"
                  type="password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Repeat master passphrase..."
                  className="font-mono text-sm"
                  required
                />
              </div>
            )}

            {errorMsg && (
              <div className="text-xs font-medium text-destructive bg-destructive/10 p-2.5 rounded border border-destructive/20 flex items-center gap-1.5">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              {isInitialized && isAdmin ? (
                <button
                  type="button"
                  onClick={() => {
                    setMode("reset");
                    setErrorMsg("");
                    setPassphrase("");
                    setConfirmPassphrase("");
                  }}
                  className="text-xs text-muted-foreground hover:text-amber-500 underline transition-colors"
                >
                  Forgot passphrase? Reset vault
                </button>
              ) : (
                <div />
              )}
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isPending} className="gap-1.5">
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isInitialized ? (
                  <>
                    <Unlock className="h-3.5 w-3.5" /> Unlock Vault
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-3.5 w-3.5" /> Initialize Vault
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
