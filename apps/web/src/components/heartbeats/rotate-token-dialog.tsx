import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatDto } from "@inv/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { heartbeatKeys, rotateHeartbeatToken, type RotateTokenResponse } from "@/lib/heartbeats-api";
import { copyText, useHeartbeatPermissions } from "./heartbeat-status";

/**
 * Replace a heartbeat's token (e.g. after the URL leaked into a log). The old URL
 * stops working immediately. For a heartbeat created from a crontab entry, RackMap
 * can rewrite that line in the same step so the job keeps reporting.
 */
export function RotateTokenDialog({
  heartbeat,
  open,
  onOpenChange,
}: {
  heartbeat: HeartbeatDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const perms = useHeartbeatPermissions();
  const linked = !!heartbeat.cronSource && heartbeat.serverId !== null;
  const needsSudo =
    !!heartbeat.cronSource && (heartbeat.cronSource.target.kind !== "user" || heartbeat.cronSource.target.user === "root");
  const canRewrite = linked && perms.canCron && (!needsSudo || perms.canSudo);
  const [rewriteCron, setRewriteCron] = useState(true);
  const [result, setResult] = useState<RotateTokenResponse | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setRewriteCron(true);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => rotateHeartbeatToken(heartbeat.id, { rewriteCron: canRewrite && rewriteCron }),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: heartbeatKeys.all });
      toast.success(r.cronRewritten ? "Token rotated and crontab line updated" : "Token rotated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const value = result ? (result.pingUrl ?? result.token) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-amber-500" /> Rotate ping token
          </DialogTitle>
          <DialogDescription>
            A new ping URL is generated and the current one ({heartbeat.tokenPrefix}…) stops working immediately.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button size="icon" variant="outline" title="Copy" onClick={async () => { if (await copyText(value)) toast.success("Copied"); }}>
                <Copy />
              </Button>
            </div>
            {result.warning && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
                <span>{result.warning}</span>
              </div>
            )}
          </div>
        ) : linked ? (
          <label className="flex items-start gap-2.5 rounded-md border border-white/10 bg-white/3 p-2.5">
            <Checkbox checked={canRewrite && rewriteCron} disabled={!canRewrite} onCheckedChange={(v) => setRewriteCron(v === true)} className="mt-0.5" />
            <div className="space-y-0.5">
              <div className="text-xs font-medium">Rewrite the crontab line on {heartbeat.server?.hostname ?? "the server"}</div>
              <div className="text-[11px] text-muted-foreground">
                {canRewrite
                  ? "The monitored entry is updated to the new token over SSH. If that fails, the old token is kept."
                  : needsSudo
                    ? "Rewriting this crontab needs the server:sudo permission; without it, update the line yourself or the job's pings will be rejected."
                    : "Rewriting crontabs needs the server:cron permission; without it, update the line yourself or the job's pings will be rejected."}
              </div>
            </div>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">Update every job that uses the old URL, or its pings will be rejected.</p>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
                {mutation.isPending ? "Rotating…" : "Rotate token"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
