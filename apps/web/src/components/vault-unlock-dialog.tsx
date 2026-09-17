import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Lock, Unlock, ShieldAlert, ShieldCheck, Loader2 } from "lucide-react";
import { fetchVaultStatus, initVault, unlockVault, lockVault, vaultKeys } from "@/lib/queries";
import { toast } from "sonner";

interface VaultUnlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function VaultUnlockDialog({ open, onOpenChange, onSuccess }: VaultUnlockDialogProps) {
  const queryClient = useQueryClient();
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    if (!passphrase) {
      setErrorMsg("Passphrase cannot be empty");
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

  const isPending = unlockMutation.isPending || initMutation.isPending || lockMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              {isUnlocked ? <Unlock className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
            </div>
            <div>
              <DialogTitle className="text-lg flex items-center gap-2">
                Credential Vault
                {isUnlocked ? (
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
                Zero-knowledge PBKDF2/AES-256 envelope encryption. Passphrase is never stored on disk.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {statusLoading ? (
          <div className="py-8 flex justify-center items-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isUnlocked ? (
          <div className="space-y-4 py-2">
            <div className="p-3.5 rounded-lg bg-muted/40 border text-xs space-y-1.5">
              <div className="flex justify-between items-center text-muted-foreground">
                <span>Status:</span>
                <span className="font-semibold text-emerald-500">Active In-Memory Session</span>
              </div>
              {status?.expiresAt && (
                <div className="flex justify-between items-center text-muted-foreground">
                  <span>Auto-locks at:</span>
                  <span className="font-mono">{new Date(status.expiresAt).toLocaleTimeString()}</span>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Your session is currently authorized to decrypt passwords and perform privileged SSH operations.
            </p>
            <DialogFooter className="flex sm:justify-between items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
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
