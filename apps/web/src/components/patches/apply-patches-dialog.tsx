import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PatchApplyMode, PatchPackageManager } from "@inv/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, PackageCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { applyServerPatches, patchKeys } from "@/lib/patches-api";
import { formatMs } from "./patch-bits";

interface ApplyPatchesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: number;
  hostname: string;
  packageManager: PatchPackageManager | null;
  securityCount: number;
  upgradableCount: number;
}

function securityHint(pm: PatchPackageManager | null): string {
  switch (pm) {
    case "apt":
      return "Runs unattended-upgrade, which installs what its configuration allows (security updates by default). Refused if unattended-upgrades is not installed.";
    case "dnf":
    case "yum":
      return `Runs ${pm} upgrade --security.`;
    case "zypper":
      return "Runs zypper patch -g security.";
    default:
      return "Installs security updates only.";
  }
}

function allHint(pm: PatchPackageManager | null): string {
  switch (pm) {
    case "apt":
      return "Runs apt-get dist-upgrade non-interactively, keeping existing config files.";
    case "dnf":
    case "yum":
      return `Runs ${pm} upgrade.`;
    case "zypper":
      return "Runs zypper update.";
    default:
      return "Installs every pending update.";
  }
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 504 || err.status === 502) {
      return `${err.message}. The update may still be running on the host; scan the server again in a few minutes.`;
    }
    return err.message;
  }
  // fetch() failing outright is usually a proxy cutting a long request.
  return "The connection was lost before the host answered. The update may still be running; scan the server again in a few minutes.";
}

/** Confirm + run "apply updates" on one server and show the package manager's output. */
export function ApplyPatchesDialog({
  open,
  onOpenChange,
  serverId,
  hostname,
  packageManager,
  securityCount,
  upgradableCount,
}: ApplyPatchesDialogProps) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<PatchApplyMode>(securityCount > 0 ? "security" : "all");
  const apply = useMutation({
    mutationFn: () => applyServerPatches(serverId, mode),
    onSuccess: (res) => {
      if (res.ok) toast.success(`Updates applied on ${hostname}`);
      else toast.error(`The package manager failed on ${hostname} (exit ${res.exitCode ?? "?"})`);
    },
    onError: (err) => toast.error(errorText(err)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: patchKeys.all });
      qc.invalidateQueries({ queryKey: patchKeys.server(serverId) });
    },
  });

  // Each opening starts from the confirmation step.
  useEffect(() => {
    if (open) {
      apply.reset();
      setMode(securityCount > 0 ? "security" : "all");
    }
  }, [open, serverId]); // `apply` is stable enough; resetting on its identity would loop

  const result = apply.data;
  const modes: { value: PatchApplyMode; label: string; hint: string; count: number }[] = [
    { value: "security", label: "Security updates only", hint: securityHint(packageManager), count: securityCount },
    { value: "all", label: "All updates", hint: allHint(packageManager), count: upgradableCount },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
              <PackageCheck className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg">Apply updates</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Installs updates on <span className="font-mono text-foreground">{hostname}</span> as root
                {packageManager && packageManager !== "unknown" ? ` with ${packageManager}` : ""}. RackMap never reboots the
                server; services may be restarted by the package manager.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!result && !apply.isPending && (
          <div className="space-y-2">
            {modes.map((m) => (
              <label
                key={m.value}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  mode === m.value ? "border-primary/50 bg-primary/10" : "border-white/10 hover:bg-white/5"
                }`}
              >
                <input
                  type="radio"
                  name="patch-mode"
                  className="mt-1 accent-primary"
                  checked={mode === m.value}
                  onChange={() => setMode(m.value)}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    {m.label}
                    <Badge variant={m.value === "security" && m.count > 0 ? "destructive" : "outline"} className="text-[10px]">
                      {m.count} pending
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{m.hint}</p>
                </div>
              </label>
            ))}
            {apply.isError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{errorText(apply.error)}</span>
              </div>
            )}
          </div>
        )}

        {apply.isPending && (
          <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p>Applying updates… this can take several minutes (up to 30).</p>
            <p className="text-xs">Closing this dialog does not stop the update on the host.</p>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {result.ok ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Succeeded
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="h-3.5 w-3.5" /> Failed (exit {result.exitCode ?? "?"})
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">in {formatMs(result.durationMs)}</span>
            </div>
            <code className="block rounded-md bg-black/30 px-2 py-1 text-[11px] font-mono text-muted-foreground break-all">
              {result.command}
            </code>
            {result.status ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">After the update:</span>
                <Badge variant={result.status.upgradableCount > 0 ? "warning" : "success"} className="text-[10px]">
                  {result.status.upgradableCount} update{result.status.upgradableCount === 1 ? "" : "s"} left
                </Badge>
                {result.status.securityCount > 0 && (
                  <Badge variant="destructive" className="text-[10px]">
                    {result.status.securityCount} security
                  </Badge>
                )}
                {result.status.rebootRequired && (
                  <Badge variant="warning" className="text-[10px] gap-1">
                    <AlertTriangle className="h-3 w-3" /> Reboot required
                  </Badge>
                )}
              </div>
            ) : (
              result.rescanError && <p className="text-xs text-amber-400">The rescan after the update failed: {result.rescanError}</p>
            )}
            <div>
              {result.outputTruncated && (
                <p className="text-[11px] text-muted-foreground mb-1">Output was long; showing the last 256 KiB.</p>
              )}
              <pre className="max-h-[45vh] overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all">
                {result.output || "(no output)"}
              </pre>
            </div>
          </div>
        )}

        <DialogFooter>
          {!result && !apply.isPending ? (
            <>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => apply.mutate()}>
                {mode === "security" ? "Apply security updates" : "Apply all updates"}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
