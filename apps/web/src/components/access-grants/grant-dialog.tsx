import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ACCESS_GRANT_PRIVILEGED_GROUPS,
  accessGrantExpiryError,
  parseTemporaryPublicKey,
  type AccessGrantKind,
  type AccessGrantMutationResponse,
} from "@inv/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, KeyRound, Loader2, ShieldAlert, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { fetchServers, serverKeys } from "@/lib/queries";
import { accessGrantKeys, createTemporaryUser, grantTemporaryKey } from "@/lib/access-grants-api";
import { cn } from "@/lib/utils";
import { ExpiryPicker, defaultExpiryChoice, resolveExpiry, useAccessGrantPermissions, type ExpiryChoice } from "./grant-status";

/**
 * Grant time-boxed access on one server: a new temporary account (locked or
 * deleted on expiry) or a temporary public key for an existing account. The
 * API re-checks everything; the checks here are for fast feedback.
 */

interface GrantAccessDialogProps {
  /** Pre-selects (and locks) the server, e.g. from the server page. */
  serverId?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind?: AccessGrantKind;
  /** Pre-fills the username (e.g. "add a temporary key for this account"). */
  defaultUsername?: string;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/;
const PRIVILEGED = new Set<string>(ACCESS_GRANT_PRIVILEGED_GROUPS);

function splitGroups(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((g) => g.trim())
    .filter(Boolean);
}

export function GrantAccessDialog({ serverId, open, onOpenChange, defaultKind = "os_user", defaultUsername }: GrantAccessDialogProps) {
  const qc = useQueryClient();
  const perms = useAccessGrantPermissions();

  const [chosenKind, setKind] = useState<AccessGrantKind>(defaultKind);
  // Editors without server:osUsers can only grant keys.
  const kind: AccessGrantKind = chosenKind === "os_user" && perms.loaded && !perms.canCreateUser ? "ssh_key" : chosenKind;
  const [server, setServer] = useState<string>(serverId ? String(serverId) : "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [shell, setShell] = useState("/bin/bash");
  const [groups, setGroups] = useState("");
  const [sudoType, setSudoType] = useState<"none" | "all_passwd" | "all_nopasswd">("none");
  const [onExpiry, setOnExpiry] = useState<"lock" | "delete">("lock");
  const [publicKey, setPublicKey] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>(() => defaultExpiryChoice());
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    setKind(defaultKind);
    setServer(serverId ? String(serverId) : "");
    setUsername(defaultUsername ?? "");
    setPassword("");
    setShell("/bin/bash");
    setGroups("");
    setSudoType("none");
    setOnExpiry("lock");
    setPublicKey("");
    setExpiry(defaultExpiryChoice());
    setReason("");
    setTouched(false);
    setOpenedAt(Date.now());
  }, [open, serverId, defaultKind, defaultUsername]);

  const { data: servers } = useQuery({
    queryKey: serverKeys.list({ picker: true, limit: 1000 }),
    queryFn: () => fetchServers({ limit: 1000 }),
    enabled: open && !serverId,
    staleTime: 60_000,
  });

  const groupList = useMemo(() => splitGroups(groups), [groups]);
  const privilegedGroups = groupList.filter((g) => PRIVILEGED.has(g.toLowerCase()));
  const keyCheck = useMemo(() => (publicKey.trim() ? parseTemporaryPublicKey(publicKey) : null), [publicKey]);
  const expiresAt = resolveExpiry(expiry, openedAt);

  const errors: string[] = [];
  if (!server) errors.push("Choose a server");
  const u = username.trim();
  if (!u) errors.push("Enter a username");
  else if (u.length > 32 || !USERNAME_PATTERN.test(u)) errors.push("Invalid Linux username");
  if (kind === "ssh_key") {
    if (!keyCheck) errors.push("Paste a public key");
    else if (!keyCheck.ok) errors.push(keyCheck.error);
    if (u === "root" && !perms.canSudo) errors.push("A key for root requires the server:sudo permission");
  } else {
    if (!perms.canSudo && (privilegedGroups.length > 0 || sudoType !== "none")) {
      errors.push("Sudo rights and privileged groups require the server:sudo permission");
    }
    if (/[\r\n]/.test(password)) errors.push("The password must not contain line breaks");
  }
  const expiryError = expiresAt ? accessGrantExpiryError(expiresAt) : "Pick an expiry";
  if (expiryError) errors.push(expiryError);
  if (!reason.trim()) errors.push("Give a reason for the grant");

  const mutation = useMutation({
    mutationFn: (): Promise<AccessGrantMutationResponse> => {
      const common = { serverId: Number(server), username: u, expiresAt: expiresAt!.toISOString(), reason: reason.trim() };
      if (kind === "ssh_key") return grantTemporaryKey({ ...common, publicKey: publicKey.trim() });
      return createTemporaryUser({
        ...common,
        onExpiry,
        ...(password ? { password } : {}),
        ...(shell.trim() ? { shell: shell.trim() } : {}),
        ...(groupList.length ? { groups: groupList } : {}),
        ...(sudoType !== "none" ? { sudoType } : {}),
      });
    },
    onSuccess: (res) => {
      toast.success(
        kind === "ssh_key"
          ? `Temporary key added for ${res.grant.username} (${res.grant.keyFingerprint ?? "key"})`
          : `Temporary account ${res.grant.username} created`,
      );
      for (const w of res.warnings) toast.warning(w);
      qc.invalidateQueries({ queryKey: accessGrantKeys.all });
      if (kind === "os_user") qc.invalidateQueries({ queryKey: serverKeys.osUsers(Number(server)) });
      onOpenChange(false);
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && e.code === "VAULT_LOCKED") {
        toast.error("The vault is locked — unlock it with the Vault button on the Servers page, then try again.");
        return;
      }
      toast.error(e.message);
    },
  });

  const submit = () => {
    setTouched(true);
    if (errors.length === 0) mutation.mutate();
  };

  const selectedServer = serverId ? null : servers?.items.find((s) => String(s.id) === server);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Grant temporary access</DialogTitle>
          <DialogDescription>
            RackMap removes the access automatically when it expires, and the host enforces the expiry too as a backstop.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { k: "os_user", icon: UserPlus, title: "Temporary user", sub: "New account, locked or deleted on expiry", allowed: perms.canCreateUser },
                { k: "ssh_key", icon: KeyRound, title: "Temporary key", sub: "Public key for an existing account", allowed: perms.canCreate },
              ] as const
            ).map((opt) => (
              <button
                key={opt.k}
                type="button"
                disabled={!opt.allowed}
                onClick={() => setKind(opt.k)}
                className={cn(
                  "flex items-start gap-2 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  kind === opt.k ? "border-primary bg-primary/10" : "border-white/10 bg-white/5 hover:bg-white/10",
                )}
              >
                <opt.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <span className="block text-sm font-medium">{opt.title}</span>
                  <span className="block text-[11px] text-muted-foreground">{opt.sub}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {!serverId && (
              <div className="space-y-1">
                <Label className="text-xs">Server *</Label>
                <Select value={server} onValueChange={setServer}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a server" />
                  </SelectTrigger>
                  <SelectContent>
                    {servers?.items.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.hostname} <span className="text-muted-foreground">({s.ip})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">{kind === "ssh_key" ? "Existing account *" : "New username *"}</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={kind === "ssh_key" ? "deploy" : "contractor-alice"}
                maxLength={32}
                autoComplete="off"
              />
            </div>
          </div>

          {kind === "os_user" ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">Password (optional)</Label>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={128} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Shell</Label>
                  <Input value={shell} onChange={(e) => setShell(e.target.value)} placeholder="/bin/bash" className="font-mono text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Supplementary groups</Label>
                  <Input value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="developers, www-data" className="font-mono text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">On expiry</Label>
                  <Select value={onExpiry} onValueChange={(v) => setOnExpiry(v as "lock" | "delete")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lock">Lock the account (keeps files)</SelectItem>
                      <SelectItem value="delete">Delete the account and its home</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {perms.canSudo && (
                <div className="space-y-1">
                  <Label className="text-xs">Sudo</Label>
                  <Select value={sudoType} onValueChange={(v) => setSudoType(v as typeof sudoType)}>
                    <SelectTrigger className="sm:w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No sudo</SelectItem>
                      <SelectItem value="all_passwd">Full sudo (password required)</SelectItem>
                      <SelectItem value="all_nopasswd">Full sudo (no password)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {(privilegedGroups.length > 0 || sudoType !== "none") && (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-md border p-2.5 text-xs",
                    perms.canSudo ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-red-500/30 bg-red-500/10 text-red-300",
                  )}
                >
                  <ShieldAlert className="mt-px h-4 w-4 shrink-0" />
                  <span>
                    {perms.canSudo
                      ? `This account will be root-equivalent${privilegedGroups.length ? ` (${privilegedGroups.join(", ")})` : ""} until it expires.`
                      : `Privileged groups (${ACCESS_GRANT_PRIVILEGED_GROUPS.join(", ")}) and sudo need the server:sudo permission.`}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-1">
              <Label className="text-xs">Public key *</Label>
              <Textarea
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… alice@laptop"
                className="font-mono text-[11px] break-all"
              />
              {keyCheck && !keyCheck.ok ? (
                <p className="text-[11px] text-red-400">{keyCheck.error}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  The bare public key only — no <code className="font-mono">command=</code> or other options. It is added to the
                  account's <code className="font-mono">~/.ssh/authorized_keys</code> with an expiry and removed when the grant ends.
                </p>
              )}
            </div>
          )}

          <ExpiryPicker choice={expiry} onChange={setExpiry} base={openedAt} />

          <div className="space-y-1">
            <Label className="text-xs">Reason *</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="INC-1234: vendor debugging the payment worker" maxLength={500} />
          </div>

          {selectedServer && (
            <p className="text-[11px] text-muted-foreground">
              On <span className="font-medium text-foreground">{selectedServer.hostname}</span> ({selectedServer.ip}).
            </p>
          )}

          {touched && errors.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-300">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <ul className="space-y-0.5">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={mutation.isPending || (touched && errors.length > 0)}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {kind === "ssh_key" ? "Add temporary key" : "Create temporary user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
