import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SudoPasswordField, useSudoPassword } from "@/components/sudo-password-field";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Terminal, Loader2, AlertCircle } from "lucide-react";
import { updateServerSudoPermission, serverKeys } from "@/lib/queries";
import type { OsUserInfo, SudoPermissionInput } from "@inv/shared";
import { toast } from "sonner";

interface SudoPermissionDialogProps {
  serverId: number;
  user: OsUserInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SudoPermissionDialog({ serverId, user, open, onOpenChange }: SudoPermissionDialogProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"none" | "all_nopasswd" | "all_passwd" | "custom">("none");
  const [customCommands, setCustomCommands] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const sudo = useSudoPassword();

  useEffect(() => {
    if (user) {
      setErrorMsg("");
      sudo.reset();
      if (user.hasSudo) {
        const hasNoPasswd = user.sudoRules.some((r) => r.includes("NOPASSWD: ALL"));
        if (hasNoPasswd) {
          setMode("all_nopasswd");
        } else {
          setMode("all_passwd");
        }
      } else {
        setMode("none");
      }
      setCustomCommands("");
    }
  }, [user, open]);

  const mutation = useMutation({
    mutationFn: (input: SudoPermissionInput) => updateServerSudoPermission(serverId, input, sudo.requestOpts()),
    onSuccess: (res) => {
      toast.success(res.message || "Sudo permissions updated successfully");
      queryClient.invalidateQueries({ queryKey: serverKeys.osUsers(serverId) });
      onOpenChange(false);
    },
    onError: (err: any) => {
      setErrorMsg(err.message || "Failed to update sudo permissions");
      sudo.onError(err);
    },
  });

  if (!user) return null;

  // Rule preview
  let previewRule = "";
  if (mode === "none") {
    previewRule = `# Sudo rights will be revoked from /etc/sudoers.d/rackmap_${user.username}`;
  } else if (mode === "all_nopasswd") {
    previewRule = `${user.username} ALL=(ALL:ALL) NOPASSWD: ALL`;
  } else if (mode === "all_passwd") {
    previewRule = `${user.username} ALL=(ALL:ALL) ALL`;
  } else if (mode === "custom") {
    const cmds = customCommands.trim() ? customCommands : "/usr/bin/systemctl";
    previewRule = `${user.username} ALL=(ALL:ALL) NOPASSWD: ${cmds}`;
  }

  const handleSave = () => {
    setErrorMsg("");
    const parsedCmds = mode === "custom"
      ? customCommands.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const input: SudoPermissionInput = {
      username: user.username,
      permissionType: mode,
      customCommands: parsedCmds,
    };
    mutation.mutate(input);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg">
                Manage Sudo Privileges: <span className="font-mono text-primary">{user.username}</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Atomic configuration via <code className="text-xs">/etc/sudoers.d/rackmap_{user.username}</code> with automated <code className="text-xs">visudo -cf</code> syntax verification.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between text-xs p-2.5 rounded bg-muted/40 border">
            <div>
              <span className="text-muted-foreground">User UID / GID: </span>
              <span className="font-mono font-medium">{user.uid}:{user.gid}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Home: </span>
              <span className="font-mono">{user.homeDir}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Current: </span>
              {user.hasSudo ? (
                <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-500 border-amber-500/20">
                  SUDO
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">None</Badge>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Permission Level</Label>
            <Select value={mode} onValueChange={(val: any) => setMode(val)}>
              <SelectTrigger className="text-xs">
                <SelectValue placeholder="Select sudo permission" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">
                  Revoke Sudo Access (No sudo)
                </SelectItem>
                <SelectItem value="all_nopasswd" className="text-xs">
                  Full Sudo Access (NOPASSWD: ALL)
                </SelectItem>
                <SelectItem value="all_passwd" className="text-xs">
                  Full Sudo Access (Requires User Password)
                </SelectItem>
                <SelectItem value="custom" className="text-xs">
                  Granular Custom Commands (NOPASSWD)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "custom" && (
            <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div className="space-y-1.5">
                <Label htmlFor="custom-cmds" className="text-xs">
                  Allowed Commands (comma-separated absolute paths)
                </Label>
                <Input
                  id="custom-cmds"
                  value={customCommands}
                  onChange={(e) => setCustomCommands(e.target.value)}
                  placeholder="/bin/systemctl restart nginx, /usr/bin/journalctl"
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  Example: <code>/bin/systemctl, /usr/bin/docker, /usr/bin/tail</code>
                </p>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Terminal className="h-3.5 w-3.5" /> Generated Sudoers Rule Preview
            </Label>
            <div className="p-2.5 rounded bg-zinc-950 font-mono text-[11px] text-zinc-200 border border-zinc-800 overflow-x-auto select-all">
              {previewRule}
            </div>
          </div>

          {errorMsg && (
            <div className="text-xs text-destructive bg-destructive/10 p-2.5 rounded border border-destructive/20 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
          <SudoPasswordField sudo={sudo} />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={mutation.isPending || (mode === "custom" && !customCommands.trim())}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Apply Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
