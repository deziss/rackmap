import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accessGrantExpiryError, type AccessGrantDto } from "@inv/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { serverKeys } from "@/lib/queries";
import { accessGrantKeys, extendAccessGrant, revokeAccessGrant } from "@/lib/access-grants-api";
import { ExpiryPicker, defaultExpiryChoice, formatDateTime, resolveExpiry, type ExpiryChoice } from "./grant-status";

/** Extend and revoke, shared by the Access grants page and the server card. */

function grantLabel(g: AccessGrantDto): string {
  const host = g.server?.hostname ?? `server ${g.serverId}`;
  return g.kind === "ssh_key" ? `the temporary key for ${g.username}@${host}` : `the temporary account ${g.username}@${host}`;
}

function toastError(e: Error) {
  if (e instanceof ApiError && e.code === "VAULT_LOCKED") {
    toast.error("The vault is locked — unlock it with the Vault button on the Servers page, then try again.");
    return;
  }
  toast.error(e.message);
}

export function ExtendGrantDialog({ grant, onOpenChange }: { grant: AccessGrantDto | null; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<ExpiryChoice>(() => defaultExpiryChoice("1d"));
  // Presets extend from the current expiry ("one more day"), not from now.
  const base = grant ? Math.max(Date.now(), new Date(grant.expiresAt).getTime()) : Date.now();

  useEffect(() => {
    if (grant) setChoice(defaultExpiryChoice("1d"));
  }, [grant]);

  const next = resolveExpiry(choice, base);
  const error = next ? accessGrantExpiryError(next) : "Pick a date and time";

  const mutation = useMutation({
    mutationFn: () => extendAccessGrant(grant!.id, next!.toISOString()),
    onSuccess: (res) => {
      toast.success(`Access now expires ${formatDateTime(res.grant.expiresAt)}`);
      for (const w of res.warnings) toast.warning(w);
      qc.invalidateQueries({ queryKey: accessGrantKeys.all });
      onOpenChange(false);
    },
    onError: toastError,
  });

  return (
    <Dialog open={!!grant} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change expiry</DialogTitle>
          <DialogDescription>
            {grant ? `${grantLabel(grant)[0]!.toUpperCase()}${grantLabel(grant).slice(1)} currently expires ${formatDateTime(grant.expiresAt)}.` : ""}{" "}
            The host's own expiry is updated too.
          </DialogDescription>
        </DialogHeader>
        <ExpiryPicker choice={choice} onChange={setChoice} base={base} label="New expiry" relativeTo="Current expiry" />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!!error || mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save expiry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevokeGrantDialog({ grant, onOpenChange }: { grant: AccessGrantDto | null; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => revokeAccessGrant(grant!.id),
    onSuccess: (res) => {
      toast.success(res.grant.kind === "ssh_key" ? "Temporary key removed" : `Account ${res.grant.username} ${res.grant.onExpiry === "delete" ? "deleted" : "locked"}`);
      qc.invalidateQueries({ queryKey: accessGrantKeys.all });
      qc.invalidateQueries({ queryKey: serverKeys.osUsers(res.grant.serverId) });
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toastError(e);
      qc.invalidateQueries({ queryKey: accessGrantKeys.all });
    },
  });

  const effect =
    grant?.kind === "ssh_key"
      ? "The key line is removed from authorized_keys."
      : grant?.onExpiry === "delete"
        ? "The account is locked, its sessions are ended, and it is deleted together with its home directory."
        : "The account is locked and expired, its RackMap sudo rule removed and its sessions ended. Its files stay.";

  return (
    <AlertDialog open={!!grant} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {grant ? grantLabel(grant) : "access"} now?</AlertDialogTitle>
          <AlertDialogDescription>{effect}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Revoke
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
