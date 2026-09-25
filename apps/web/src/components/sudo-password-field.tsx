import { useCallback, useState } from "react";
import { KeyRound } from "lucide-react";
import { ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * sudo on the host rejected (or needed) a password: the saved server password
 * is stale or missing, or the vault holding it is locked. RackMap usually logs
 * in with an SSH key, so this only surfaces when something needs root.
 */
export function isSudoPasswordError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === "SUDO_ERROR" || err.code === "VAULT_LOCKED") &&
    /password/i.test(err.message)
  );
}

export interface SudoPasswordState {
  needed: boolean;
  value: string;
  setValue(value: string): void;
  /** Call from a mutation's onError. */
  onError(err: unknown): void;
  reset(): void;
  /** Options to hand to the API call (header X-Sudo-Password, used once, never saved). */
  requestOpts(): { sudoPassword?: string };
}

export function useSudoPassword(): SudoPasswordState {
  const [needed, setNeeded] = useState(false);
  const [value, setValue] = useState("");
  const onError = useCallback((err: unknown) => {
    if (isSudoPasswordError(err)) setNeeded(true);
  }, []);
  const reset = useCallback(() => {
    setNeeded(false);
    setValue("");
  }, []);
  return {
    needed,
    value,
    setValue,
    onError,
    reset,
    requestOpts: () => (value ? { sudoPassword: value } : {}),
  };
}

/** Shown after sudo refused the saved password; the retry sends what is typed here. */
export function SudoPasswordField({ sudo, sshUser }: { sudo: SudoPasswordState; sshUser?: string }) {
  if (!sudo.needed) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <Label htmlFor="sudo-password" className="text-xs flex items-center gap-1.5">
        <KeyRound className="h-3.5 w-3.5 text-amber-500" />
        Sudo password{sshUser ? ` for ${sshUser}` : ""}
      </Label>
      <Input
        id="sudo-password"
        type="password"
        autoComplete="off"
        className="h-8 text-xs"
        value={sudo.value}
        onChange={(e) => sudo.setValue(e.target.value)}
        placeholder="Enter it and retry"
      />
      <p className="text-[11px] text-muted-foreground">
        Used once for sudo on this host and not saved. To stop being asked, update the server's saved password or grant
        the SSH user passwordless sudo.
      </p>
    </div>
  );
}
