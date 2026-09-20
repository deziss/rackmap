import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Lock, Unlock, ShieldAlert, ShieldCheck, Loader2, RotateCcw, ArrowLeft } from "lucide-react";
import { fetchVaultStatus, initVault, unlockVault, lockVault, vaultKeys } from "@/lib/queries";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";

type VaultResetMode = "initialized" | "rekeyed" | "destroyed";

interface VaultResetPayload {
  newPassphrase: string;
  /** Proof of knowledge — required unless the destructive recovery path is used. */
  currentPassphrase?: string;
  /** Explicit recovery path: mints a new data key and orphans every stored credential. */
  forceDestroy?: true;
}

function submitVaultReset(payload: VaultResetPayload) {
  return apiFetch<{ ok: boolean; mode: VaultResetMode }>("/api/v1/vault/reset", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

const DESTROY_CONFIRM_PHRASE = "DESTROY";

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
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [forgotCurrent, setForgotCurrent] = useState(false);
  const [destroyConfirm, setDestroyConfirm] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const clearResetFields = () => {
    setCurrentPassphrase("");
    setForgotCurrent(false);
    setDestroyConfirm("");
  };

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
    mutationFn: submitVaultReset,
    onSuccess: (result) => {
      toast.success(
        result.mode === "destroyed"
          ? "Master Vault re-keyed with a new data key — previously stored passwords must be re-entered."
          : "Master Vault passphrase changed. Existing stored passwords are unaffected.",
      );
      queryClient.invalidateQueries({ queryKey: vaultKeys.status });
      setPassphrase("");
      setConfirmPassphrase("");
      clearResetFields();
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
      if (!forgotCurrent) {
        if (!currentPassphrase) {
          setErrorMsg("Enter the current master passphrase to change it");
          return;
        }
        resetMutation.mutate({ newPassphrase: passphrase, currentPassphrase });
        return;
      }
      if (destroyConfirm.trim() !== DESTROY_CONFIRM_PHRASE) {
        setErrorMsg(`Type ${DESTROY_CONFIRM_PHRASE} to confirm that every stored password will be lost`);
        return;
      }
      resetMutation.mutate({ newPassphrase: passphrase, forceDestroy: true });
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
          clearResetFields();
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
                  ? "Change the master vault passphrase, or recover a forgotten one."
                  : "PBKDF2/AES-256 envelope encryption for server credentials."}
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
            {!forgotCurrent ? (
              <div className="p-3 rounded-md bg-muted/40 border text-xs space-y-1">
                <strong>Change master passphrase</strong>
                <p className="text-muted-foreground">
                  The current passphrase is required. The vault data key is re-wrapped under the new passphrase, so every
                  stored password keeps working.
                </p>
              </div>
            ) : (
              <div className="p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-xs space-y-1">
                <strong>Destructive recovery — this cannot be undone:</strong>
                <p>
                  Without the current passphrase the vault data key cannot be recovered. Continuing generates a brand new
                  data key and <strong>permanently orphans every password already stored in the vault</strong>; each one
                  has to be re-entered by hand afterwards.
                </p>
              </div>
            )}

            {!forgotCurrent && (
              <div className="space-y-2">
                <Label htmlFor="current-vault-passphrase" className="text-xs">
                  Current Master Passphrase
                </Label>
                <div className="relative">
                  <Input
                    id="current-vault-passphrase"
                    type="password"
                    value={currentPassphrase}
                    onChange={(e) => setCurrentPassphrase(e.target.value)}
                    placeholder="Enter the passphrase in use today..."
                    className="pr-9 font-mono text-sm"
                    autoFocus
                    required
                  />
                  <KeyRound className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
                </div>
              </div>
            )}

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

            {forgotCurrent && (
              <div className="space-y-2">
                <Label htmlFor="destroy-confirm" className="text-xs text-destructive">
                  Type {DESTROY_CONFIRM_PHRASE} to confirm that all stored passwords will be lost
                </Label>
                <Input
                  id="destroy-confirm"
                  type="text"
                  value={destroyConfirm}
                  onChange={(e) => setDestroyConfirm(e.target.value)}
                  placeholder={DESTROY_CONFIRM_PHRASE}
                  className="font-mono text-sm"
                  autoComplete="off"
                  required
                />
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                setForgotCurrent((v) => !v);
                setCurrentPassphrase("");
                setDestroyConfirm("");
                setErrorMsg("");
              }}
              className="text-xs text-muted-foreground hover:text-destructive underline transition-colors"
            >
              {forgotCurrent
                ? "I do know the current passphrase — go back"
                : "I have lost the current passphrase (destroys all stored passwords)"}
            </button>

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
                  clearResetFields();
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Unlock
              </Button>
              <Button
                type="submit"
                variant={forgotCurrent ? "destructive" : "default"}
                size="sm"
                disabled={isPending}
                className="gap-1.5"
              >
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <RotateCcw className="h-3.5 w-3.5" />
                {forgotCurrent ? "Destroy & Re-key Vault" : "Change Passphrase"}
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
                      clearResetFields();
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
                    clearResetFields();
                  }}
                  className="text-xs text-muted-foreground hover:text-amber-500 underline transition-colors"
                >
                  Change or recover the master passphrase
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
