import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sparkles, CheckCircle2, KeyRound, Loader2, ArrowRight } from "lucide-react";
import { activateLicense, licenseKeys } from "@/lib/queries";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";

interface UpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  featureName?: string;
  featureDescription?: string;
}

export function UpgradeDialog({
  open,
  onOpenChange,
  featureName = "This Feature",
  featureDescription = "This feature requires a RackMap Pro or Enterprise license.",
}: UpgradeDialogProps) {
  const [licenseKey, setLicenseKey] = useState("");
  const queryClient = useQueryClient();

  const activateMutation = useMutation({
    mutationFn: activateLicense,
    onSuccess: (data) => {
      toast.success(`Successfully activated ${data.planName}!`);
      queryClient.invalidateQueries({ queryKey: licenseKeys.all });
      onOpenChange(false);
      setLicenseKey("");
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to activate license key");
    },
  });

  const handleActivate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseKey.trim()) return;
    activateMutation.mutate({ key: licenseKey.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <Badge className="bg-primary/20 text-primary border-primary/30 flex items-center gap-1 text-[11px] font-semibold">
              <Sparkles className="h-3 w-3" /> PRO FEATURE
            </Badge>
          </div>
          <DialogTitle className="text-lg font-bold">{featureName}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
            {featureDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Plan Comparison Highlights */}
          <div className="rounded-lg border bg-muted/20 p-3 space-y-2 text-xs">
            <div className="font-semibold text-foreground flex items-center justify-between">
              <span>What RackMap Pro Unlocks:</span>
              <span className="text-[10px] text-muted-foreground font-normal">Powered by Licencia</span>
            </div>
            <ul className="space-y-1.5 text-muted-foreground text-[11px]">
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span><strong>100+ Managed Servers</strong> (vs 10 on Free Edition)</span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span><strong>Hardware Auto-Discovery</strong> over SSH in seconds</span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span><strong>ATOP Historical Spikes & Replay</strong> root-cause analysis</span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span><strong>Remote OS Users & Sudoers</strong> fleet-wide management</span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span><strong>Multi-Channel Alerts</strong> (Slack, Discord, Telegram)</span>
              </li>
            </ul>
          </div>

          {/* Quick Activation Form */}
          <form onSubmit={handleActivate} className="space-y-2">
            <label className="text-xs font-medium text-foreground block">
              Have a Licencia Key? Enter it to activate:
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  placeholder="LIC-XXXX-XXXX-XXXX-XXXX"
                  className="pl-8 text-xs font-mono"
                  disabled={activateMutation.isPending}
                />
              </div>
              <Button
                type="submit"
                size="sm"
                disabled={!licenseKey.trim() || activateMutation.isPending}
                className="gap-1.5 text-xs shrink-0"
              >
                {activateMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Activate
              </Button>
            </div>
          </form>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between border-t pt-3">
          <Link
            to="/settings"
            onClick={() => onOpenChange(false)}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            Manage in Settings <ArrowRight className="h-3 w-3" />
          </Link>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="text-xs">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
