import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { registerSudoPrompt, type SudoPromptAnswer, type SudoPromptRequest } from "@/lib/api";
import { fetchMe, systemKeys } from "@/lib/queries";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

interface Pending {
  request: SudoPromptRequest;
  resolve: (answer: SudoPromptAnswer | null) => void;
}

/**
 * One app-wide prompt for sudo passwords. Any API call that fails because sudo
 * on the host needs (or rejected) a password lands here; the call is retried
 * with what the user types (lib/api.ts). Concurrent failures share one prompt.
 */
export function SudoPromptHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [saveToServer, setSaveToServer] = useState(false);
  const inflight = useRef<Promise<SudoPromptAnswer | null> | null>(null);

  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 5 * 60 * 1000 });
  const canSave = !!me?.can?.["server.update"];

  useEffect(
    () =>
      registerSudoPrompt((request) => {
        if (inflight.current) return inflight.current;
        const p = new Promise<SudoPromptAnswer | null>((resolve) => {
          setPassword("");
          setSaveToServer(false);
          setPending({ request, resolve });
        }).finally(() => {
          inflight.current = null;
        });
        inflight.current = p;
        return p;
      }),
    [],
  );

  const finish = (answer: SudoPromptAnswer | null) => {
    pending?.resolve(answer);
    setPending(null);
    setPassword("");
  };

  const request = pending?.request;
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && finish(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-amber-500" /> Sudo password needed
          </DialogTitle>
          <DialogDescription className="text-xs">
            {request?.retry ? "That password was rejected too. " : ""}
            {request?.message}. Enter the sudo password of the server's SSH user to continue.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) finish({ password, remember, saveToServer: canSave && saveToServer });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="global-sudo-password" className="text-xs">
              Sudo password
            </Label>
            <Input
              id="global-sudo-password"
              type="password"
              autoComplete="off"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} className="mt-0.5" />
            <span>Remember for this server until I reload the page (kept in memory only)</span>
          </label>
          {canSave && request?.serverId != null && (
            <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
              <Checkbox checked={saveToServer} onCheckedChange={(v) => setSaveToServer(v === true)} className="mt-0.5" />
              <span>
                Also save it as this server's password (encrypted). Background jobs — patch scans, drift scans, runbooks,
                access-grant expiry — use the saved password, so this fixes them too.
              </span>
            </label>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" size="sm" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!password}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
