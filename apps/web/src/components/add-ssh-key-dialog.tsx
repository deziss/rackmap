import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Key, Loader2, ShieldCheck, AlertCircle } from "lucide-react";
import { addSshKey, sshKeyKeys } from "@/lib/queries";
import { toast } from "sonner";

interface AddSshKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddSshKeyDialog({ open, onOpenChange }: AddSshKeyDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const addMutation = useMutation({
    mutationFn: () =>
      addSshKey({
        name: name.trim(),
        privateKey: privateKey.trim(),
        passphrase: passphrase.trim() || undefined,
      }),
    onSuccess: (res) => {
      toast.success(`SSH Key "${res.name}" stored securely on host.`);
      queryClient.invalidateQueries({ queryKey: sshKeyKeys.all });
      setName("");
      setPrivateKey("");
      setPassphrase("");
      setErrorMsg("");
      onOpenChange(false);
    },
    onError: (err: any) => {
      setErrorMsg(err.message || "Failed to add SSH key");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg("Please provide a friendly name for this key.");
      return;
    }
    if (!privateKey.trim() || !privateKey.includes("PRIVATE KEY")) {
      setErrorMsg("Please provide a valid OpenSSH or PEM private key.");
      return;
    }
    setErrorMsg("");
    addMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Key className="h-4 w-4 text-primary" />
            Add Custom SSH Private Key
          </DialogTitle>
          <DialogDescription className="text-xs">
            Store an SSH private key on the host storage (<code className="font-mono">/data/ssh_keys/</code>) with 0600 file permissions for agentless server authentication.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Key Name / Label</Label>
            <Input
              placeholder="e.g. Production Cluster Key (ED25519)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-xs"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">OpenSSH Private Key</Label>
            <textarea
              className="w-full h-32 p-2.5 rounded-md border bg-muted/40 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Key Passphrase (Optional)</Label>
            <Input
              type="password"
              placeholder="Leave empty if key has no passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="text-xs"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={addMutation.isPending}
              className="text-xs gap-1.5"
            >
              {addMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              Save SSH Key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
