import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SudoPasswordField, useSudoPassword } from "@/components/sudo-password-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  UserPlus,
  Trash2,
  Lock,
  Unlock,
  KeyRound,
  ShieldCheck,
  Folder,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  Dice5,
  AlertTriangle,
  Check,
} from "lucide-react";
import {
  createServerOsUser,
  updateServerOsUser,
  deleteServerOsUser,
  serverKeys,
  fetchMe,
  systemKeys,
} from "@/lib/queries";
import type {
  OsUserInfo,
  CreateOsUserInput,
  UpdateOsUserInput,
  DeleteOsUserInput,
} from "@inv/shared";
import { toast } from "sonner";

// Helper: generate random strong password
function generateSecurePassword(length = 16): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*()_+";
  let pwd = "";
  const cryptoObj = window.crypto || (window as any).msCrypto;
  if (cryptoObj && cryptoObj.getRandomValues) {
    const values = new Uint32Array(length);
    cryptoObj.getRandomValues(values);
    for (let i = 0; i < length; i++) {
      pwd += chars[values[i] % chars.length];
    }
  } else {
    for (let i = 0; i < length; i++) {
      pwd += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return pwd;
}

const COMMON_SHELLS = [
  { value: "/bin/bash", label: "/bin/bash (Default Linux Shell)" },
  { value: "/bin/sh", label: "/bin/sh (POSIX Shell)" },
  { value: "/bin/zsh", label: "/bin/zsh (Z Shell)" },
  { value: "/usr/sbin/nologin", label: "/usr/sbin/nologin (No Interactive Login)" },
  { value: "/bin/false", label: "/bin/false (Disabled Login)" },
];

const COMMON_GROUPS = ["sudo", "docker", "adm", "www-data", "staff", "systemd-journal"];

// Mirrors PRIVILEGED_OS_GROUPS in apps/api/src/services/os-user.service.ts: granting
// any of these (or sudo rules) needs server:sudo, so editors are not offered them.
const PRIVILEGED_GROUP_NAMES = new Set(["sudo", "wheel", "admin", "docker", "lxd", "disk", "root", "adm", "shadow"]);

/** Whether the signed-in user may grant sudo rules and privileged groups. */
function useCanSudo(): boolean {
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 5 * 60 * 1000 });
  return !!me?.can?.["server.sudo"];
}

// ======================================================================
// 1. CREATE OS USER DIALOG
// ======================================================================
interface CreateOsUserDialogProps {
  serverId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateOsUserDialog({
  serverId,
  open,
  onOpenChange,
}: CreateOsUserDialogProps) {
  const queryClient = useQueryClient();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [shell, setShell] = useState("/bin/bash");
  const [homeDir, setHomeDir] = useState("");
  const [autoHome, setAutoHome] = useState(true);
  const [createHome, setCreateHome] = useState(true);
  const [isSystemUser, setIsSystemUser] = useState(false);
  const [groups, setGroups] = useState("");
  const [uid, setUid] = useState("");
  const [gid, setGid] = useState("");
  const [sudoType, setSudoType] = useState<"none" | "all_nopasswd" | "all_passwd" | "custom">("none");
  const [customCommands, setCustomCommands] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const sudo = useSudoPassword();
  const canSudo = useCanSudo();

  // Reset fields on open
  useEffect(() => {
    if (open) {
      setUsername("");
      setPassword("");
      setShowPassword(false);
      setShell("/bin/bash");
      setHomeDir("");
      setAutoHome(true);
      setCreateHome(true);
      setIsSystemUser(false);
      setGroups("");
      setUid("");
      setGid("");
      setSudoType("none");
      setCustomCommands("");
      setErrorMsg("");
      sudo.reset();
    }
  }, [open]);

  // Sync auto home dir
  const handleUsernameChange = (val: string) => {
    setUsername(val);
    if (autoHome) {
      setHomeDir(val.trim() ? `/home/${val.trim().toLowerCase()}` : "");
    }
  };

  const handleToggleGroup = (grp: string) => {
    const list = groups
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    if (list.includes(grp)) {
      setGroups(list.filter((g) => g !== grp).join(", "));
    } else {
      setGroups([...list, grp].join(", "));
    }
  };

  const mutation = useMutation({
    mutationFn: (input: CreateOsUserInput) => createServerOsUser(serverId, input, sudo.requestOpts()),
    onSuccess: (res) => {
      toast.success(res.message || `User account "${username}" created successfully`);
      queryClient.invalidateQueries({ queryKey: serverKeys.osUsers(serverId) });
      onOpenChange(false);
    },
    onError: (err: any) => {
      setErrorMsg(err.message || "Failed to create user");
      sudo.onError(err);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUser = username.trim();
    if (!cleanUser) {
      setErrorMsg("Username is required");
      return;
    }

    const parsedGroups = groups
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);

    const payload: CreateOsUserInput = {
      username: cleanUser,
      password: password ? password : undefined,
      shell: shell || "/bin/bash",
      homeDir: homeDir.trim() || undefined,
      createHome,
      groups: parsedGroups.length > 0 ? parsedGroups : undefined,
      isSystemUser,
      uid: uid ? parseInt(uid, 10) : undefined,
      gid: gid ? parseInt(gid, 10) : undefined,
      sudoType,
      customCommands:
        sudoType === "custom"
          ? customCommands
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
          : undefined,
    };

    mutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-5 w-5 text-emerald-500" />
            Add New OS User Account
          </DialogTitle>
          <DialogDescription className="text-xs">
            Create a local Linux account on this server with full configuration options.
          </DialogDescription>
        </DialogHeader>

        {errorMsg && (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        <SudoPasswordField sudo={sudo} />

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Section: Basic Identity */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">
                Username <span className="text-destructive">*</span>
              </Label>
              <Input
                placeholder="e.g. devops, deployer, john"
                value={username}
                onChange={(e) => handleUsernameChange(e.target.value)}
                className="h-8 text-xs font-mono"
                required
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Login Shell</Label>
              <Select value={shell} onValueChange={setShell}>
                <SelectTrigger className="h-8 text-xs font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_SHELLS.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-xs font-mono">
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Section: Password */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">Password (Optional)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] gap-1 text-primary hover:text-primary/80"
                onClick={() => setPassword(generateSecurePassword(16))}
              >
                <Dice5 className="h-3.5 w-3.5" /> Generate Strong Password
              </Button>
            </div>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Leave blank for key-only access"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-8 text-xs font-mono pr-16"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              If set, the account can be accessed via SSH password authentication.
            </p>
          </div>

          {/* Section: Home Directory */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">Home Directory</Label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoHome}
                  onChange={(e) => {
                    setAutoHome(e.target.checked);
                    if (e.target.checked && username) {
                      setHomeDir(`/home/${username.trim().toLowerCase()}`);
                    }
                  }}
                  className="rounded border-border"
                />
                Auto-fill
              </label>
            </div>
            <div className="relative">
              <Folder className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="/home/username"
                value={homeDir}
                onChange={(e) => {
                  setAutoHome(false);
                  setHomeDir(e.target.value);
                }}
                className="pl-8 h-8 text-xs font-mono"
              />
            </div>
            <div className="flex items-center gap-4 pt-0.5">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={createHome}
                  onChange={(e) => setCreateHome(e.target.checked)}
                  className="rounded border-border"
                />
                Create home directory (<code className="font-mono text-[10px]">-m</code>)
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={isSystemUser}
                  onChange={(e) => setIsSystemUser(e.target.checked)}
                  className="rounded border-border"
                />
                System account (<code className="font-mono text-[10px]">-r</code>, no aging)
              </label>
            </div>
          </div>

          {/* Section: Secondary Groups */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Secondary Groups</Label>
            <Input
              placeholder="e.g. sudo, docker, adm"
              value={groups}
              onChange={(e) => setGroups(e.target.value)}
              className="h-8 text-xs font-mono"
            />
            <div className="flex flex-wrap gap-1 pt-1">
              <span className="text-[10px] text-muted-foreground mr-1">Quick Add:</span>
              {COMMON_GROUPS.filter((grp) => canSudo || !PRIVILEGED_GROUP_NAMES.has(grp)).map((grp) => {
                const isSelected = groups
                  .split(",")
                  .map((g) => g.trim())
                  .includes(grp);
                return (
                  <Badge
                    key={grp}
                    variant={isSelected ? "default" : "outline"}
                    className="cursor-pointer text-[10px] py-0 px-1.5 font-mono select-none"
                    onClick={() => handleToggleGroup(grp)}
                  >
                    {grp} {isSelected && "✓"}
                  </Badge>
                );
              })}
            </div>
          </div>

          {/* Section: UID & GID (Advanced) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Custom UID (Optional)</Label>
              <Input
                type="number"
                placeholder="Auto"
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Custom GID (Optional)</Label>
              <Input
                type="number"
                placeholder="Auto"
                value={gid}
                onChange={(e) => setGid(e.target.value)}
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>

          {/* Section: Sudo Privileges */}
          {canSudo ? (
            <div className="p-3 rounded-lg border bg-muted/20 space-y-2.5">
              <Label className="text-xs font-semibold flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-amber-500" /> Sudoers Privileges
              </Label>
              <Select
                value={sudoType}
                onValueChange={(val: any) => setSudoType(val)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="text-xs">
                    None (Standard Unprivileged User)
                  </SelectItem>
                  <SelectItem value="all_nopasswd" className="text-xs font-mono">
                    Full Sudo without Password (NOPASSWD: ALL)
                  </SelectItem>
                  <SelectItem value="all_passwd" className="text-xs font-mono">
                    Full Sudo with Password Required (ALL=(ALL:ALL) ALL)
                  </SelectItem>
                  <SelectItem value="custom" className="text-xs font-mono">
                    Custom Restricted Commands
                  </SelectItem>
                </SelectContent>
              </Select>

              {sudoType === "custom" && (
                <div className="space-y-1 pt-1">
                  <Label className="text-[11px] text-muted-foreground">
                    Allowed Commands (comma-separated):
                  </Label>
                  <Input
                    placeholder="/usr/bin/systemctl restart nginx, /usr/bin/docker ps"
                    value={customCommands}
                    onChange={(e) => setCustomCommands(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Sudo rules and privileged groups (sudo, docker, adm, …) can only be granted by an admin.
            </p>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={mutation.isPending || !username.trim()}
            >
              {mutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserPlus className="h-3.5 w-3.5" />
              )}
              Create Account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================
// 2. EDIT OS USER DIALOG
// ======================================================================
interface EditOsUserDialogProps {
  serverId: number;
  user: OsUserInfo | null;
  currentSshUser?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditOsUserDialog({
  serverId,
  user,
  currentSshUser,
  open,
  onOpenChange,
}: EditOsUserDialogProps) {
  const queryClient = useQueryClient();

  const [shell, setShell] = useState("/bin/bash");
  const [homeDir, setHomeDir] = useState("");
  const [groups, setGroups] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [sudoType, setSudoType] = useState<"none" | "all_nopasswd" | "all_passwd" | "custom">("none");
  const [customCommands, setCustomCommands] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const sudo = useSudoPassword();
  const canSudo = useCanSudo();

  useEffect(() => {
    if (user && open) {
      setShell(user.shell || "/bin/bash");
      setHomeDir(user.homeDir || "");
      setGroups(user.groups ? user.groups.join(", ") : "");
      setPassword("");
      setShowPassword(false);
      setIsLocked(false);
      setErrorMsg("");
      sudo.reset();

      if (user.hasSudo) {
        const hasNoPasswd = user.sudoRules.some((r) => r.includes("NOPASSWD: ALL"));
        if (hasNoPasswd) {
          setSudoType("all_nopasswd");
        } else {
          setSudoType("all_passwd");
        }
      } else {
        setSudoType("none");
      }
      setCustomCommands("");
    }
  }, [user, open]);

  const handleToggleGroup = (grp: string) => {
    const list = groups
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    if (list.includes(grp)) {
      setGroups(list.filter((g) => g !== grp).join(", "));
    } else {
      setGroups([...list, grp].join(", "));
    }
  };

  const mutation = useMutation({
    mutationFn: (input: UpdateOsUserInput) => {
      if (!user) throw new Error("No user selected");
      return updateServerOsUser(serverId, user.username, input, sudo.requestOpts());
    },
    onSuccess: (res) => {
      toast.success(res.message || `User "${user?.username}" updated successfully`);
      queryClient.invalidateQueries({ queryKey: serverKeys.osUsers(serverId) });
      onOpenChange(false);
    },
    onError: (err: any) => {
      setErrorMsg(err.message || "Failed to update user");
      sudo.onError(err);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const parsedGroups = groups
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);

    const payload: UpdateOsUserInput = {
      shell: shell !== user.shell ? shell : undefined,
      homeDir: homeDir !== user.homeDir ? homeDir : undefined,
      groups: parsedGroups,
      password: password ? password : undefined,
      isLocked,
      sudoType,
      customCommands:
        sudoType === "custom"
          ? customCommands
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
          : undefined,
    };

    mutation.mutate(payload);
  };

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-5 w-5 text-primary" />
            Edit OS User: <span className="font-mono text-foreground">{user.username}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            Modify login shell, groups, password, account lock state, and sudoers privileges.
          </DialogDescription>
        </DialogHeader>

        {/* User Summary Card */}
        <div className="p-3 rounded-lg border bg-muted/30 grid grid-cols-3 gap-2 text-xs font-mono">
          <div>
            <span className="text-[10px] text-muted-foreground uppercase block">UID : GID</span>
            <span className="font-bold">{user.uid} : {user.gid}</span>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground uppercase block">Account Type</span>
            <span>{user.isSystemUser ? "System User" : "Regular User"}</span>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground uppercase block">SSH User</span>
            <span>{user.username === currentSshUser ? "Active SSH User" : "Standard"}</span>
          </div>
        </div>

        {errorMsg && (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        <SudoPasswordField sudo={sudo} />

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Shell & Home Dir */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Login Shell</Label>
              <Select value={shell} onValueChange={setShell}>
                <SelectTrigger className="h-8 text-xs font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_SHELLS.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-xs font-mono">
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Home Directory</Label>
              <div className="relative">
                <Folder className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={homeDir}
                  onChange={(e) => setHomeDir(e.target.value)}
                  className="pl-8 h-8 text-xs font-mono"
                />
              </div>
            </div>
          </div>

          {/* Secondary Groups */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Secondary Groups</Label>
            <Input
              placeholder="e.g. sudo, docker, adm"
              value={groups}
              onChange={(e) => setGroups(e.target.value)}
              className="h-8 text-xs font-mono"
            />
            <div className="flex flex-wrap gap-1 pt-1">
              <span className="text-[10px] text-muted-foreground mr-1">Quick Add:</span>
              {COMMON_GROUPS.filter((grp) => canSudo || !PRIVILEGED_GROUP_NAMES.has(grp)).map((grp) => {
                const isSelected = groups
                  .split(",")
                  .map((g) => g.trim())
                  .includes(grp);
                return (
                  <Badge
                    key={grp}
                    variant={isSelected ? "default" : "outline"}
                    className="cursor-pointer text-[10px] py-0 px-1.5 font-mono select-none"
                    onClick={() => handleToggleGroup(grp)}
                  >
                    {grp} {isSelected && "✓"}
                  </Badge>
                );
              })}
            </div>
          </div>

          {/* Reset Password */}
          <div className="space-y-1.5 p-3 rounded-lg border bg-muted/10">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-primary" /> Reset / Change Password
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] gap-1 text-primary hover:text-primary/80"
                onClick={() => setPassword(generateSecurePassword(16))}
              >
                <Dice5 className="h-3.5 w-3.5" /> Generate
              </Button>
            </div>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Leave blank to keep existing password unchanged"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-8 text-xs font-mono pr-16"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Account Lock/Unlock */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/20">
            <div>
              <div className="font-semibold text-xs flex items-center gap-1.5">
                {isLocked ? <Lock className="h-4 w-4 text-destructive" /> : <Unlock className="h-4 w-4 text-emerald-500" />}
                Account Status
              </div>
              <p className="text-[11px] text-muted-foreground">
                Locking prevents password logins while retaining keys and data.
              </p>
            </div>
            <Button
              type="button"
              variant={isLocked ? "destructive" : "outline"}
              size="sm"
              className="h-7 text-xs gap-1.5 font-mono"
              onClick={() => setIsLocked(!isLocked)}
            >
              {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
              {isLocked ? "Account Locked" : "Account Active"}
            </Button>
          </div>

          {/* Sudoers Privileges */}
          {canSudo ? (
            <div className="p-3 rounded-lg border bg-muted/20 space-y-2.5">
              <Label className="text-xs font-semibold flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-amber-500" /> Sudoers Privileges
              </Label>
              <Select
                value={sudoType}
                onValueChange={(val: any) => setSudoType(val)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="text-xs">
                    None (Remove sudo rules)
                  </SelectItem>
                  <SelectItem value="all_nopasswd" className="text-xs font-mono">
                    Full Sudo without Password (NOPASSWD: ALL)
                  </SelectItem>
                  <SelectItem value="all_passwd" className="text-xs font-mono">
                    Full Sudo with Password Required (ALL=(ALL:ALL) ALL)
                  </SelectItem>
                  <SelectItem value="custom" className="text-xs font-mono">
                    Custom Restricted Commands
                  </SelectItem>
                </SelectContent>
              </Select>

              {sudoType === "custom" && (
                <div className="space-y-1 pt-1">
                  <Label className="text-[11px] text-muted-foreground">
                    Allowed Commands (comma-separated):
                  </Label>
                  <Input
                    placeholder="/usr/bin/systemctl restart nginx, /usr/bin/docker ps"
                    value={customCommands}
                    onChange={(e) => setCustomCommands(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Sudo rules and privileged groups (sudo, docker, adm, …) can only be granted by an admin.
            </p>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="gap-1.5"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================
// 3. DELETE OS USER DIALOG
// ======================================================================
interface DeleteOsUserDialogProps {
  serverId: number;
  user: OsUserInfo | null;
  currentSshUser?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteOsUserDialog({
  serverId,
  user,
  currentSshUser,
  open,
  onOpenChange,
}: DeleteOsUserDialogProps) {
  const queryClient = useQueryClient();

  const [confirmInput, setConfirmInput] = useState("");
  const [removeHome, setRemoveHome] = useState(true);
  const [force, setForce] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const sudo = useSudoPassword();

  useEffect(() => {
    if (open) {
      setConfirmInput("");
      setRemoveHome(true);
      setForce(false);
      setErrorMsg("");
      sudo.reset();
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: (input: DeleteOsUserInput) => {
      if (!user) throw new Error("No user selected");
      return deleteServerOsUser(serverId, user.username, input, sudo.requestOpts());
    },
    onSuccess: (res) => {
      toast.success(res.message || `User "${user?.username}" deleted successfully`);
      queryClient.invalidateQueries({ queryKey: serverKeys.osUsers(serverId) });
      onOpenChange(false);
    },
    onError: (err: any) => {
      setErrorMsg(err.message || "Failed to delete user");
      sudo.onError(err);
    },
  });

  if (!user) return null;

  const isRoot = user.username === "root";
  const isCurrentSsh = user.username === currentSshUser;
  const isPrivilegedOrHuman = user.uid >= 1000 || user.hasSudo || isCurrentSsh;
  const canConfirm = !isRoot && (!isPrivilegedOrHuman || confirmInput.trim() === user.username);

  const handleDelete = () => {
    if (!canConfirm) return;
    mutation.mutate({ removeHome, force });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-destructive">
            <Trash2 className="h-5 w-5 text-destructive" />
            Delete OS User: <span className="font-mono">{user.username}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            Permanently remove this Linux user account from the server.
          </DialogDescription>
        </DialogHeader>

        {isRoot ? (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/40 text-destructive text-xs space-y-1">
            <div className="font-bold flex items-center gap-1.5">
              <AlertCircle className="h-4 w-4" /> Root Account Safeguard
            </div>
            <p>
              The <strong>root</strong> user is the core administrator of the operating system and cannot be deleted.
            </p>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            {isCurrentSsh && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 space-y-1">
                <div className="font-bold flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4" /> Critical Warning
                </div>
                <p>
                  <strong>{user.username}</strong> is the configured SSH management user for this server. Deleting this account will permanently terminate RackMap SSH connectivity.
                </p>
              </div>
            )}

            <div className="p-3 rounded-lg border bg-muted/40 font-mono space-y-1 text-[11px]">
              <div>UID / GID: <strong>{user.uid} : {user.gid}</strong></div>
              <div>Home Directory: <strong>{user.homeDir}</strong></div>
              <div>Shell: <strong>{user.shell}</strong></div>
              <div>Sudo Rights: <strong>{user.hasSudo ? "Yes" : "No"}</strong></div>
            </div>

            {errorMsg && (
              <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}
            <SudoPasswordField sudo={sudo} />

            {/* Options */}
            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={removeHome}
                  onChange={(e) => setRemoveHome(e.target.checked)}
                  className="rounded border-border"
                />
                <span>Remove user home directory and mail spool (<code className="font-mono text-[10px]">userdel -r</code>)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  className="rounded border-border"
                />
                <span>Force deletion even if user has running processes (<code className="font-mono text-[10px]">userdel -f</code>)</span>
              </label>
            </div>

            {isPrivilegedOrHuman && (
              <div className="space-y-1.5 pt-2 border-t">
                <Label className="text-xs">
                  Type <strong className="font-mono text-destructive">{user.username}</strong> to confirm deletion:
                </Label>
                <Input
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder={user.username}
                  className="h-8 text-xs font-mono"
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="gap-1.5"
            onClick={handleDelete}
            disabled={!canConfirm || mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete User
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
