import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import {
  fetchServer,
  fetchServerMetrics,
  serverKeys,
  fetchServices,
  serviceKeys,
  systemKeys,
  fetchMe,
  revealPassword,
  autoDiscoverServer,
  fetchServerOsUsers,
  queryServerLogs,
  fetchAtopDates,
  fetchAtopSnapshots,
  fetchAtopTopProcesses,
  fetchVaultStatus,
  vaultKeys,
  fetchSshKeys,
  removeSshKey,
  testServerSshKey,
  sshKeyKeys,
  fetchAutoUpdateStatus,
  updateAutoUpdateStatus,
  autoUpdateKeys,
  fetchServerAlertChannels,
  sendServerTestAlert,
  alertChannelKeys,
  updateServer,
} from "@/lib/queries";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { StatusDot } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { SshTerminal } from "@/components/ssh-terminal";
import { VaultUnlockDialog } from "@/components/vault-unlock-dialog";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { fetchLicenseStatus, licenseKeys } from "@/lib/queries";
import { SudoPermissionDialog } from "@/components/sudo-permission-dialog";
import { PaginationBar } from "@/components/pagination-bar";
import { CreateOsUserDialog, EditOsUserDialog, DeleteOsUserDialog } from "@/components/os-user-dialogs";
import { AtopProcessModal } from "@/components/atop-process-modal";
import { AddSshKeyDialog } from "@/components/add-ssh-key-dialog";
import { RequestAccessButton } from "@/components/request-access-button";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Bell,
  Send,
  Trash2,
  Plus,
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  Zap,
  Terminal,
  Copy,
  Check,
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  Lock,
  FileText,
  Users,
  Activity,
  Flame,
  Download,
  RefreshCw,
  Search,
  Eye,
  EyeOff,
  Wand2,
  Server,
  AlertCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Clock,
  RotateCcw,
  Sparkles,
  UserPlus,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ProcInfo,
  ServerHardwareInfo,
  OsUserInfo,
  LogPriority,
  LogQueryInput,
  AtopIntervalSnapshot,
  AtopQueryInput,
  AtopProcess,
  AtopTopProcesses,
} from "@inv/shared";

export const Route = createFileRoute("/_auth/servers/$serverId")({
  component: ServerDetailPage,
});

function fmtBytes(n: number): string {
  if (!n || isNaN(n)) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-muted">
      <div
        className={cn("h-full rounded transition-all", color ?? "bg-primary")}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function ProcTable({ procs, kind }: { procs: ProcInfo[]; kind: "cpu" | "mem" }) {
  if (!procs || procs.length === 0) return <p className="text-xs text-muted-foreground">No process data</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="text-left font-medium pb-1">PID</th>
          <th className="text-left font-medium pb-1">Process</th>
          <th className="text-right font-medium pb-1">CPU%</th>
          <th className="text-right font-medium pb-1">MEM%</th>
        </tr>
      </thead>
      <tbody>
        {procs.map((p) => (
          <tr key={p.pid} className="border-t border-border/50">
            <td className="py-0.5 text-muted-foreground font-mono">{p.pid}</td>
            <td className="py-0.5 font-mono truncate max-w-[12rem]">{p.comm}</td>
            <td className={cn("py-0.5 text-right font-mono", kind === "cpu" && "font-semibold")}>
              {p.cpu.toFixed(1)}
            </td>
            <td className={cn("py-0.5 text-right font-mono", kind === "mem" && "font-semibold")}>
              {p.mem.toFixed(1)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CopySSHButton({
  server,
  sudo = false,
}: {
  server: { ip: string; username: string; sshPort: number };
  sudo?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const cmd = sudo
    ? `ssh -p ${server.sshPort} ${server.username}@${server.ip} -t sudo su -`
    : `ssh -p ${server.sshPort} ${server.username}@${server.ip}`;
  const copy = () => {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      toast.success(sudo ? "Root SSH command copied" : "SSH command copied");
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Button size="sm" variant="outline" className="gap-1.5 font-mono text-xs h-8" onClick={copy} title={cmd}>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : sudo ? (
        <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {sudo ? "sudo ssh" : "ssh"}
    </Button>
  );
}

function ServerDetailPage() {
  const { serverId } = Route.useParams();
  const id = Number(serverId);
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<"overview" | "metrics" | "atop" | "logs" | "users" | "terminal">("overview");
  const [vaultModalOpen, setVaultModalOpen] = useState(false);
  const [selectedUserForSudo, setSelectedUserForSudo] = useState<OsUserInfo | null>(null);
  const [selectedAtopSnapshot, setSelectedAtopSnapshot] = useState<AtopIntervalSnapshot | null>(null);
  const [addSshKeyOpen, setAddSshKeyOpen] = useState(false);
  const [createOsUserOpen, setCreateOsUserOpen] = useState(false);
  const [selectedUserForEdit, setSelectedUserForEdit] = useState<OsUserInfo | null>(null);
  const [selectedUserForDelete, setSelectedUserForDelete] = useState<OsUserInfo | null>(null);

  // Revealed password state
  const [revealedPwd, setRevealedPwd] = useState<string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const [copiedPwd, setCopiedPwd] = useState(false);

  const { data: session } = authClient.useSession();
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe });
  const sshEnabled = me?.features?.sshEnabled ?? true;
  const userRole = session?.user?.role;
  const canAdmin = userRole === "admin" || userRole === "editor";
  const isViewer = userRole === "viewer";

  // Viewer: fetch own access requests to derive per-server approval
  const { data: myRequests } = useQuery({
    queryKey: ["access-requests", "mine"],
    queryFn: () => apiFetch<{ serverId: number; type: string; status: string; expiresAt: string | null }[]>("/api/v1/access-requests"),
    enabled: isViewer,
    refetchInterval: 15_000,
  });

  function viewerApproved(type: "ssh" | "password_reveal"): boolean {
    if (canAdmin) return true;
    if (!myRequests) return false;
    const now = Date.now();
    return myRequests.some(
      (r) =>
        r.serverId === id &&
        r.type === type &&
        r.status === "approved" &&
        (r.expiresAt === null || new Date(r.expiresAt).getTime() > now),
    );
  }

  // Vault status
  const { data: vaultStatus } = useQuery({
    queryKey: vaultKeys.status,
    queryFn: fetchVaultStatus,
  });

  // Server Details
  const { data: server, isLoading: serverLoading } = useQuery({
    queryKey: serverKeys.detail(id),
    queryFn: () => fetchServer(id),
  });

  const [discoveredHardware, setDiscoveredHardware] = useState<ServerHardwareInfo | null>(null);
  const [serverPasswordDialogOpen, setServerPasswordDialogOpen] = useState(false);
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);
  const [upgradeFeatureInfo, setUpgradeFeatureInfo] = useState({
    name: "Hardware Auto-Discovery via SSH",
    description: "Remotely inspect CPU models, RAM DIMMs, block partitions (lsblk), and GPU accelerators over SSH in seconds. Requires a RackMap Pro subscription.",
  });

  const { data: license } = useQuery({
    queryKey: licenseKeys.status(),
    queryFn: fetchLicenseStatus,
  });

  const hw: ServerHardwareInfo | null = useMemo(() => {
    if (discoveredHardware) return discoveredHardware;
    if ((server as any)?.hardwareInfo) return (server as any).hardwareInfo;
    if (server?.cpu || server?.ram || server?.osType) {
      const cpuParts = (server.cpu || "").split(" - ");
      const coresMatch = cpuParts[0]?.match(/(\\d+)\\s*Cores?/i);
      const cores = coresMatch ? parseInt(coresMatch[1]!, 10) : 1;
      const model = cpuParts[1] || server.cpu || "Generic CPU";
      return {
        cpuModel: model,
        cpuCores: cores,
        cpuThreads: cores,
        ramBytes: 0,
        ramFormatted: server.ram || "—",
        osName: server.osType || "Linux",
        kernel: "Linux",
        arch: "x86_64",
        hostname: server.hostname,
        gpuCount: server.gpuCount ?? 0,
        gpuModel: null,
        disks: [],
        uptime: "Active",
      };
    }
    return null;
  }, [discoveredHardware, server]);

  // Auto-discover mutation
  const discoverMutation = useMutation({
    mutationFn: () => autoDiscoverServer(id),
    onSuccess: (data: any) => {
      const hwInfo: ServerHardwareInfo = data?.hardware || data;
      setDiscoveredHardware(hwInfo);
      const cpuDesc = hwInfo?.cpuModel || (hwInfo?.cpuCores ? `${hwInfo.cpuCores} Cores` : "CPU");
      const ramDesc = hwInfo?.ramFormatted || "RAM";
      const diskCount = hwInfo?.disks?.length ?? 0;
      toast.success(
        `Hardware discovery complete: ${cpuDesc}, ${ramDesc}, ${diskCount} Disks detected!`
      );
      queryClient.invalidateQueries({ queryKey: serverKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: serverKeys.all });
    },
    onError: (err: any) => {
      if (err.message?.includes("subscription") || err.message?.includes("Pro or Enterprise") || err.code === "FEATURE_LOCKED") {
        setUpgradeFeatureInfo({
          name: "Hardware Auto-Discovery via SSH",
          description: "Remotely inspect CPU models, RAM DIMMs, block partitions (lsblk), and GPU accelerators over SSH in seconds. Requires a RackMap Pro subscription.",
        });
        setUpgradeDialogOpen(true);
        return;
      }
      if (err.code === "VAULT_LOCKED" || err.message?.includes("Vault is locked")) {
        setVaultModalOpen(true);
        toast.error("Unlock the Credential Vault first to decrypt SSH credentials.");
      } else if (err.message?.includes("SSH authentication failed") || err.message?.includes("usable SSH credentials")) {
        toast.error(err.message || "SSH authentication failed with host key");
        setServerPasswordDialogOpen(true);
      } else {
        toast.error(err.message || "Failed to auto-discover hardware over SSH");
      }
    },
  });

  const handleRevealPassword = async () => {
    if (revealedPwd) {
      setRevealedPwd(null);
      return;
    }
    setIsRevealing(true);
    try {
      const res = await revealPassword(id);
      setRevealedPwd(res.password);
    } catch (err: any) {
      if (err.code === "VAULT_LOCKED") {
        setVaultModalOpen(true);
        toast.error("Unlock the Credential Vault to decrypt this server password.");
      } else {
        toast.error(err.message || "Failed to reveal password");
      }
    } finally {
      setIsRevealing(false);
    }
  };

  const copyPassword = () => {
    if (!revealedPwd) return;
    void navigator.clipboard.writeText(revealedPwd).then(() => {
      setCopiedPwd(true);
      toast.success("Password copied to clipboard");
      setTimeout(() => setCopiedPwd(false), 2000);
    });
  };

  if (serverLoading) {
    return (
      <div className="h-[70vh] flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm">Loading server details and infrastructure telemetry...</p>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="p-8 text-center space-y-3">
        <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
        <h2 className="text-lg font-semibold">Server not found</h2>
        <p className="text-sm text-muted-foreground">The requested server ID #{id} does not exist or has been removed.</p>
        <Link to="/servers">
          <Button variant="outline" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to Servers
          </Button>
        </Link>
      </div>
    );
  }

  

  return (
    <div className="space-y-4 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col gap-3 p-4 rounded-xl border bg-card/60 backdrop-blur">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/servers">
              <Button size="sm" variant="ghost" className="gap-1.5 h-8 text-xs">
                <ArrowLeft className="h-3.5 w-3.5" /> Servers
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <StatusDot
                status={server.lastStatus as "up" | "down" | "unknown"}
                latencyMs={server.lastLatencyMs}
                ip={server.ip}
                port={server.sshPort}
              />
              <h1 className="text-xl font-bold font-mono tracking-tight">{server.hostname}</h1>
            </div>
            {server.domain && <Badge variant="secondary" className="text-xs">{server.domain}</Badge>}
            {server.environment && (
              <Badge variant="outline" className="text-xs uppercase font-mono tracking-wider">
                {server.environment}
              </Badge>
            )}
            {server.cloudProvider && <Badge variant="secondary" className="text-xs">{server.cloudProvider.name}</Badge>}
            {server.networkType && (
              <Badge variant="secondary" className="text-xs bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
                {server.networkType.name}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Vault Status Trigger */}
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 text-xs font-mono"
              onClick={() => setVaultModalOpen(true)}
              title={vaultStatus?.isUnlocked ? "Credential Vault Unlocked" : "Credential Vault Locked"}
            >
              {vaultStatus?.isUnlocked ? (
                <>
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                  <span className="text-emerald-500">Vault: Unlocked</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                  <span className="text-amber-500">Vault: Locked</span>
                </>
              )}
            </Button>

            {/* Reveal Password Action */}
            {canAdmin || viewerApproved("password_reveal") ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 h-8 text-xs"
                onClick={handleRevealPassword}
                disabled={isRevealing}
              >
                {isRevealing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : revealedPwd ? (
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <Eye className="h-3.5 w-3.5 text-primary" />
                )}
                {revealedPwd ? "Hide Password" : "Reveal Password"}
              </Button>
            ) : server.hasPassword ? (
              <RequestAccessButton entityId={id} entityType="server" type="password_reveal" label="Password" />
            ) : null}

            {/* Auto-Discover Hardware Button */}
            {canAdmin && (
              <Button
                size="sm"
                variant="default"
                className="gap-1.5 h-8 text-xs bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-sm"
                onClick={() => {
                  if (license && (!license.features?.hardware_discovery || license.tier === "free")) {
                    setUpgradeFeatureInfo({
                      name: "Hardware Auto-Discovery via SSH",
                      description: "Remotely inspect CPU models, RAM DIMMs, block partitions (lsblk), and GPU accelerators over SSH in seconds. Requires a RackMap Pro subscription.",
                    });
                    setUpgradeDialogOpen(true);
                    return;
                  }
                  discoverMutation.mutate();
                }}
                disabled={discoverMutation.isPending}
              >
                {discoverMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wand2 className="h-3.5 w-3.5" />
                )}
                Auto-Discover Hardware
                {license?.tier === "free" && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1 border-white/40 text-white/90">PRO</Badge>
                )}
              </Button>
            )}

            {/* Request SSH Access for viewers if not approved */}
            {!canAdmin && !viewerApproved("ssh") && (
              <RequestAccessButton entityId={id} entityType="server" type="ssh" label="SSH Terminal" />
            )}

            {/* SSH Commands */}
            <CopySSHButton server={{ ip: server.ip, username: server.username, sshPort: server.sshPort }} />
            <CopySSHButton server={{ ip: server.ip, username: server.username, sshPort: server.sshPort }} sudo />
          </div>
        </div>

        {/* Revealed Password Banner */}
        {revealedPwd && (
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/60 border border-primary/20 text-xs mt-1 animate-in fade-in slide-in-from-top-1">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary shrink-0" />
              <span className="text-muted-foreground">Decrypted Server Password:</span>
              <code className="px-2 py-0.5 rounded bg-background font-mono text-sm font-semibold text-primary">
                {revealedPwd}
              </code>
            </div>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={copyPassword}>
              {copiedPwd ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedPwd ? "Copied" : "Copy"}
            </Button>
          </div>
        )}

        {/* Server Subheader Meta */}
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/50">
          <div className="flex items-center gap-4 flex-wrap">
            <span>
              SSH Endpoint: <strong className="font-mono text-foreground">{server.username}@{server.ip}:{server.sshPort}</strong>
            </span>
            {server.location && (
              <span>Location: <strong className="text-foreground">{server.location.name}</strong></span>
            )}
            {server.purpose && (
              <span>Purpose: <strong className="text-foreground">{server.purpose}</strong></span>
            )}
            {hw?.osName && (
              <span>OS: <strong className="text-foreground">{hw.osName}</strong></span>
            )}
          </div>
          {hw?.uptime && (
            <span className="text-[11px] text-muted-foreground">
              Uptime: {hw.uptime}
            </span>
          )}
        </div>
      </div>

      {/* Navigation Tabs Bar */}
      <div className="flex items-center gap-1 border-b pb-1 overflow-x-auto">
        <Button
          variant={activeTab === "overview" ? "secondary" : "ghost"}
          size="sm"
          className={cn("gap-1.5 text-xs h-8 font-medium", activeTab === "overview" && "bg-secondary shadow-sm")}
          onClick={() => setActiveTab("overview")}
        >
          <Server className="h-3.5 w-3.5" /> Overview & Specs
        </Button>

        <Button
          variant={activeTab === "metrics" ? "secondary" : "ghost"}
          size="sm"
          className={cn("gap-1.5 text-xs h-8 font-medium", activeTab === "metrics" && "bg-secondary shadow-sm")}
          onClick={() => setActiveTab("metrics")}
        >
          <Activity className="h-3.5 w-3.5" /> Live Metrics (5s)
        </Button>

        <Button
          variant={activeTab === "atop" ? "secondary" : "ghost"}
          size="sm"
          className={cn("gap-1.5 text-xs h-8 font-medium", activeTab === "atop" && "bg-secondary shadow-sm")}
          onClick={() => setActiveTab("atop")}
        >
          <Flame className="h-3.5 w-3.5 text-amber-500" /> ATOP History & Spikes
        </Button>

        <Button
          variant={activeTab === "logs" ? "secondary" : "ghost"}
          size="sm"
          className={cn("gap-1.5 text-xs h-8 font-medium", activeTab === "logs" && "bg-secondary shadow-sm")}
          onClick={() => setActiveTab("logs")}
        >
          <FileText className="h-3.5 w-3.5 text-blue-500" /> Forensic Logs & Evidence
        </Button>

        <Button
          variant={activeTab === "users" ? "secondary" : "ghost"}
          size="sm"
          className={cn("gap-1.5 text-xs h-8 font-medium", activeTab === "users" && "bg-secondary shadow-sm")}
          onClick={() => setActiveTab("users")}
        >
          <Users className="h-3.5 w-3.5 text-emerald-500" /> OS Users & Sudoers
        </Button>

        {sshEnabled && (canAdmin || viewerApproved("ssh")) && (
          <Button
            variant={activeTab === "terminal" ? "secondary" : "ghost"}
            size="sm"
            className={cn("gap-1.5 text-xs h-8 font-medium", activeTab === "terminal" && "bg-secondary shadow-sm")}
            onClick={() => setActiveTab("terminal")}
          >
            <Terminal className="h-3.5 w-3.5 text-purple-400" /> Web Terminal
          </Button>
        )}
      </div>

      {/* Tab 1: Overview & Specs */}
      {activeTab === "overview" && (
        <OverviewTab
          server={server}
          hw={hw}
          onAddCustomKey={() => setAddSshKeyOpen(true)}
          onOpenPasswordModal={() => setServerPasswordDialogOpen(true)}
        />
      )}

      {/* Tab 2: Live Metrics */}
      {activeTab === "metrics" && <LiveMetricsTab serverId={id} />}

      {/* Tab 3: ATOP History */}
      {activeTab === "atop" && (
        <AtopTab
          serverId={id}
          onSelectSnapshot={(snap) => setSelectedAtopSnapshot(snap)}
        />
      )}

      {/* Tab 4: Logs Viewer */}
      {activeTab === "logs" && <LogsViewerTab serverId={id} />}

      {/* Tab 5: OS Users & Sudoers */}
      {activeTab === "users" && (
        <OsUsersTab
          serverId={id}
          currentSshUser={server.username}
          onAddUser={() => setCreateOsUserOpen(true)}
          onEditUser={(user) => setSelectedUserForEdit(user)}
          onDeleteUser={(user) => setSelectedUserForDelete(user)}
          onManageSudo={(user) => setSelectedUserForSudo(user)}
        />
      )}

      {/* Tab 6: Web Terminal */}
      {activeTab === "terminal" && (
        <div className="p-4 rounded-xl border bg-card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Terminal className="h-4 w-4 text-purple-400" /> SSH Terminal Session: {server.hostname}
            </h2>
            <span className="text-xs text-muted-foreground font-mono">
              Port: {server.sshPort} · User: {server.username}
            </span>
          </div>
          <SshTerminal serverId={id} onClose={() => setActiveTab("overview")} className="h-[600px]" />
        </div>
      )}

      {/* Dialogs */}
      <AddSshKeyDialog open={addSshKeyOpen} onOpenChange={setAddSshKeyOpen} />

      <UpgradeDialog
        open={upgradeDialogOpen}
        onOpenChange={setUpgradeDialogOpen}
        featureName={upgradeFeatureInfo.name}
        featureDescription={upgradeFeatureInfo.description}
      />

      {server && (
        <ServerPasswordDialog
          serverId={server.id}
          hostname={server.hostname}
          ip={server.ip}
          username={server.username}
          sshPort={server.sshPort}
          open={serverPasswordDialogOpen}
          onOpenChange={setServerPasswordDialogOpen}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: serverKeys.detail(id) });
            discoverMutation.mutate();
          }}
        />
      )}

      <VaultUnlockDialog
        open={vaultModalOpen}
        onOpenChange={setVaultModalOpen}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: vaultKeys.status });
          queryClient.invalidateQueries({ queryKey: serverKeys.detail(id) });
        }}
      />

      <SudoPermissionDialog
        serverId={id}
        user={selectedUserForSudo}
        open={!!selectedUserForSudo}
        onOpenChange={(open) => !open && setSelectedUserForSudo(null)}
      />

      <CreateOsUserDialog
        serverId={id}
        open={createOsUserOpen}
        onOpenChange={setCreateOsUserOpen}
      />

      <EditOsUserDialog
        serverId={id}
        user={selectedUserForEdit}
        currentSshUser={server?.username}
        open={!!selectedUserForEdit}
        onOpenChange={(open) => !open && setSelectedUserForEdit(null)}
      />

      <DeleteOsUserDialog
        serverId={id}
        user={selectedUserForDelete}
        currentSshUser={server?.username}
        open={!!selectedUserForDelete}
        onOpenChange={(open) => !open && setSelectedUserForDelete(null)}
      />

      <AtopProcessModal
        serverId={id}
        snapshot={selectedAtopSnapshot}
        open={!!selectedAtopSnapshot}
        onOpenChange={(open) => !open && setSelectedAtopSnapshot(null)}
      />
    </div>
  );
}

// ----------------------------------------------------------------------
// TAB 1: Overview & Specs
// ----------------------------------------------------------------------
function OverviewTab({
  server,
  hw,
  onAddCustomKey,
  onOpenPasswordModal,
}: {
  server: any;
  hw: ServerHardwareInfo | null;
  onAddCustomKey: () => void;
  onOpenPasswordModal: () => void;
}) {
  const { data: servicesData } = useQuery({
    queryKey: serviceKeys.list({ q: server?.ip ?? "" }),
    queryFn: () => fetchServices({ q: server?.ip ?? "" }),
    enabled: !!server?.ip,
  });

  const relatedServices = servicesData?.items?.filter((s: any) => s.serverIp === server?.ip) ?? [];

  return (
    <div className="space-y-4">
      {/* Hardware Specifications Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Processor */}
        <Card className="shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Cpu className="h-4 w-4 text-blue-500" /> Processor (CPU)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 space-y-2">
            <div className="text-lg font-bold font-mono text-foreground">
              {hw?.cpuCores ? `${hw.cpuCores} Cores` : server.cpu ? (server.cpu.includes("Cores") ? server.cpu.split(" - ")[0] : server.cpu) : "—"}
            </div>
            <p className="text-xs text-muted-foreground font-mono line-clamp-2">
              {hw?.cpuModel || server.cpu || "Model not recorded"}
            </p>
            <div className="pt-2 border-t border-border/50 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
              <span>Arch: <strong className="text-foreground">{hw?.arch || "x86_64"}</strong></span>
              <span>Threads: <strong className="text-foreground">{hw?.cpuThreads || hw?.cpuCores || 1}</strong></span>
            </div>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card className="shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <MemoryStick className="h-4 w-4 text-emerald-500" /> Memory (RAM)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 space-y-2">
            <div className="text-lg font-bold font-mono text-foreground">
              {hw?.ramFormatted ? hw.ramFormatted : server.ram ? server.ram : "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              {hw?.ramBytes ? `${(hw.ramBytes / (1024 * 1024 * 1024)).toFixed(1)} GB detected` : "Physical Memory"}
            </p>
            <div className="pt-2 border-t border-border/50 text-[11px] text-muted-foreground">
              <span>Status: <strong className="text-emerald-400">Available</strong></span>
            </div>
          </CardContent>
        </Card>

        {/* Storage */}
        <Card className="shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <HardDrive className="h-4 w-4 text-amber-500" /> Disks & Storage
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 space-y-2">
            <div className="text-lg font-bold font-mono text-foreground">
              {hw?.disks?.[0]?.size || server.disk || (hw?.disks?.length ? `${hw.disks.length} Devices` : "—")}
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {hw?.disks?.map((d) => `${d.name} (${d.size})`).join(", ") || (server.disk ? `Primary: ${server.disk}` : "Block devices")}
            </p>
            <div className="pt-2 border-t border-border/50 text-[11px] text-muted-foreground">
              <span>Primary: <strong className="font-mono text-foreground">{hw?.disks?.[0]?.name || "/dev/nvme0n1"}</strong></span>
            </div>
          </CardContent>
        </Card>

        {/* OS & Kernel */}
        <Card className="shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-purple-500" /> OS & Kernel
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1 space-y-2">
            <div className="text-base font-bold font-mono truncate text-foreground" title={hw?.osName}>
              {hw?.osName || server.osType || "Linux"}
            </div>
            <p className="text-xs text-muted-foreground font-mono truncate" title={hw?.kernel}>
              {hw?.kernel || "Kernel version"}
            </p>
            <div className="pt-2 border-t border-border/50 text-[11px] text-muted-foreground truncate">
              <span>Uptime: <strong className="text-foreground">{hw?.uptime || "Active"}</strong></span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Disks Breakdown Table if available */}
      {hw?.disks && hw.disks.length > 0 && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-amber-500" /> Discovered Storage Devices & Partitions (lsblk)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground text-[11px]">
                  <th className="py-2 text-left font-medium">Device Name</th>
                  <th className="py-2 text-left font-medium">Type</th>
                  <th className="py-2 text-left font-medium">Size</th>
                  <th className="py-2 text-left font-medium">Model / Vendor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 font-mono text-[11px]">
                {hw.disks.map((d, i) => (
                  <tr key={`${d.name}-${i}`} className="hover:bg-muted/20">
                    <td className="py-2 font-semibold text-foreground">{d.name}</td>
                    <td className="py-2">
                      <Badge variant="secondary" className="text-[10px] uppercase">{d.type}</Badge>
                    </td>
                    <td className="py-2 font-medium">{d.size}</td>
                    <td className="py-2 text-muted-foreground">{d.model || "Generic Block Device"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* GPU Accelerators if detected */}
      {hw && hw.gpuCount > 0 && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Zap className="h-4 w-4 text-purple-500" /> Detected GPUs & Hardware Accelerators ({hw.gpuCount})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="p-2.5 rounded bg-muted/30 border text-xs flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono text-[10px]">GPU #0</Badge>
                <span className="font-medium font-mono">{hw.gpuModel || "NVIDIA Graphics Device"}</span>
              </div>
              <Badge variant="secondary" className="text-[10px]">Active</Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Server Inventory Config Metadata */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">Inventory Metadata</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs space-y-2">
            <div className="flex justify-between py-1 border-b border-border/40">
              <span className="text-muted-foreground">Server ID:</span>
              <span className="font-mono">{server.id}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/40">
              <span className="text-muted-foreground">IPv4 Address:</span>
              <span className="font-mono font-medium">{server.ip}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/40">
              <span className="text-muted-foreground">SSH Port & User:</span>
              <span className="font-mono">{server.username} (Port {server.sshPort})</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/40">
              <span className="text-muted-foreground">Authentication Method:</span>
              <Badge variant="secondary" className="text-[10px] capitalize">{server.authType}</Badge>
            </div>
            <div className="flex justify-between py-1 border-b border-border/40">
              <span className="text-muted-foreground">Datacenter / Location:</span>
              <span>{server.location?.name ?? "—"}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/40">
              <span className="text-muted-foreground">Server Type:</span>
              <span>{server.serverType?.name ?? "—"}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">Created:</span>
              <span>{new Date(server.createdAt).toLocaleDateString()}</span>
            </div>
          </CardContent>
        </Card>

        {/* Hosted Services */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold flex items-center justify-between">
              <span>Hosted Applications & Services</span>
              <Badge variant="secondary" className="text-[10px]">{relatedServices.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {relatedServices.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No microservices mapped to this server IP.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-muted-foreground text-[10px]">
                    <th className="py-1.5 text-left font-medium">Service</th>
                    <th className="py-1.5 text-left font-medium">Type</th>
                    <th className="py-1.5 text-left font-medium">Port</th>
                    <th className="py-1.5 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40 font-mono text-[11px]">
                  {relatedServices.map((s: any) => (
                    <tr key={s.id}>
                      <td className="py-1.5 font-medium">{s.name}</td>
                      <td className="py-1.5 text-muted-foreground">{s.serviceType || "—"}</td>
                      <td className="py-1.5">{s.port || "—"}</td>
                      <td className="py-1.5 text-right">
                        {s.lastStatus === "up" ? (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-emerald-500/30 text-emerald-400">UP</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-rose-500/30 text-rose-400">DOWN</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

      </div>

      {/* SSH Key Access & Host Key Discovery */}
      <SshKeyAccessCard server={server} onAddCustomKey={onAddCustomKey} onOpenPasswordModal={onOpenPasswordModal} />

      {/* Automated System Updates (Unattended-Upgrades) */}
      <AutoUpdateCard serverId={server.id} />

      {/* Alert Channels & Live Notification Dispatcher (CloudScope Feature) */}
      <AlertChannelsCard serverId={server.id} />
    </div>
  );
}


// ----------------------------------------------------------------------
// Sub-Card: SSH Authentication & Credentials (Keys & Passwords)
// ----------------------------------------------------------------------
function SshKeyAccessCard({
  server,
  onAddCustomKey,
  onOpenPasswordModal,
}: {
  server: any;
  onAddCustomKey: () => void;
  onOpenPasswordModal: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: keysData, isLoading: keysLoading } = useQuery({
    queryKey: sshKeyKeys.all,
    queryFn: fetchSshKeys,
  });

  const [testingKey, setTestingKey] = useState(false);
  const [testingPassword, setTestingPassword] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const keys = keysData?.keys ?? [];

  const handleTestKey = async () => {
    setTestingKey(true);
    setTestResult(null);
    try {
      const res = await testServerSshKey(server.id, { authMethod: "key" });
      if (res.success) {
        setTestResult(`✓ Key Auth: ${res.message}`);
        toast.success(res.message);
      } else {
        setTestResult(`✕ Key Auth: ${res.message}`);
        toast.error(res.message);
      }
    } catch (err: any) {
      setTestResult(`✕ Key Auth: ${err.message || "Failed to test key"}`);
      toast.error(err.message || "Failed to test key");
    } finally {
      setTestingKey(false);
    }
  };

  const handleTestPassword = async () => {
    if (!server.hasPassword) {
      toast.info("No password stored yet for this server. Please enter a password.");
      onOpenPasswordModal();
      return;
    }
    setTestingPassword(true);
    setTestResult(null);
    try {
      const res = await testServerSshKey(server.id, { authMethod: "password" });
      if (res.success) {
        setTestResult(`✓ Password Auth: ${res.message}`);
        toast.success(res.message);
      } else {
        setTestResult(`✕ Password Auth: ${res.message}`);
        toast.error(res.message);
      }
    } catch (err: any) {
      setTestResult(`✕ Password Auth: ${err.message || "Failed to test password"}`);
      toast.error(err.message || "Failed to test password");
    } finally {
      setTestingPassword(false);
    }
  };

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeSshKey(id),
    onSuccess: () => {
      toast.success("SSH key removed");
      queryClient.invalidateQueries({ queryKey: sshKeyKeys.all });
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to remove key");
    },
  });

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" />
          <CardTitle className="text-sm font-semibold">
            SSH Authentication & Credentials
          </CardTitle>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={handleTestKey}
            disabled={testingKey || testingPassword}
          >
            {testingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5 text-blue-400" />}
            Test Key Login
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={handleTestPassword}
            disabled={testingKey || testingPassword}
          >
            {testingPassword ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />}
            Test Password Login
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5 border-primary/40 text-primary hover:bg-primary/10"
            onClick={onOpenPasswordModal}
          >
            <Lock className="h-3.5 w-3.5" />
            {server.hasPassword ? "Change Password" : "Set Password"}
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={onAddCustomKey}
          >
            <Plus className="h-3.5 w-3.5" /> Add Custom Key
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        {/* Status banner */}
        <div className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/20 text-xs">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-primary" />
            <span className="font-medium text-foreground">Password Authentication:</span>
            {server.hasPassword ? (
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px]">
                Configured in Vault
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-amber-400 bg-amber-500/15 border-amber-500/30 text-[10px]">
                Not Set (Remote SSH requires key or password prompt)
              </Badge>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs text-primary hover:underline px-2"
            onClick={onOpenPasswordModal}
          >
            {server.hasPassword ? "Update Password" : "Enter Password"}
          </Button>
        </div>

        {testResult && (
          <div
            className={cn(
              "p-2.5 rounded-lg border text-xs font-mono flex items-center justify-between",
              testResult.startsWith("✓")
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                : "bg-destructive/10 border-destructive/20 text-destructive"
            )}
          >
            <span>{testResult}</span>
            <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px]" onClick={() => setTestResult(null)}>
              Dismiss
            </Button>
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          <p>
            When connecting to <strong className="text-foreground">{server.username}@{server.ip}</strong>, the backend verifies authentication using available host keys or custom keys before automatically falling back to stored password and PAM keyboard-interactive. Privileged commands seamlessly elevate using the decrypted Vault password.
          </p>
        </div>

        {keysLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading available keys...
          </div>
        ) : keys.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No SSH keys found on host storage.</p>
        ) : (
          <div className="divide-y divide-border/40 border rounded-lg overflow-hidden">
            {keys.map((k) => (
              <div key={k.id} className="p-2.5 flex items-center justify-between text-xs hover:bg-muted/20">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{k.name}</span>
                    <Badge variant={k.source === "host" ? "outline" : "secondary"} className="text-[10px] uppercase">
                      {k.source}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] font-mono uppercase">
                      {k.keyType}
                    </Badge>
                    {k.isDefault && (
                      <Badge className="text-[10px] bg-primary/20 text-primary border-primary/30">
                        Host Default
                      </Badge>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate max-w-md">
                    {k.fingerprint} {k.path && `· ${k.path}`}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {k.source === "custom" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeMutation.mutate(k.id)}
                      title="Delete custom key"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------
// Dialog: Set / Test Server Password
// ----------------------------------------------------------------------
function ServerPasswordDialog({
  serverId,
  hostname,
  ip,
  username,
  sshPort,
  open,
  onOpenChange,
  onSuccess,
}: {
  serverId: number;
  hostname: string;
  ip: string;
  username: string;
  sshPort: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<{ success: boolean; message: string } | null>(null);

  const handleTest = async () => {
    if (!password) {
      toast.error("Enter a password to test");
      return;
    }
    setTesting(true);
    setTestStatus(null);
    try {
      const res = await testServerSshKey(serverId, { authMethod: "password", password });
      setTestStatus(res);
      if (res.success) {
        toast.success(res.message);
      } else {
        toast.error(res.message);
      }
    } catch (err: any) {
      setTestStatus({ success: false, message: err.message || "Failed to test password" });
      toast.error(err.message || "Failed to test password");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      toast.error("Please enter a password");
      return;
    }
    setSaving(true);
    try {
      await updateServer(serverId, { password });
      toast.success("Server password saved and encrypted in Vault!");
      queryClient.invalidateQueries({ queryKey: serverKeys.detail(serverId) });
      onOpenChange(false);
      setPassword("");
      setTestStatus(null);
      onSuccess?.();
    } catch (err: any) {
      toast.error(err.message || "Failed to save password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Set Server SSH Password
          </DialogTitle>
          <DialogDescription>
            Configure SSH password for <strong className="text-foreground">{username}@{ip}:{sshPort}</strong> ({hostname}).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSave} className="space-y-4 pt-2">
          {testStatus && (
            <div
              className={cn(
                "p-2.5 rounded-lg border text-xs font-mono flex items-center justify-between",
                testStatus.success
                  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                  : "bg-destructive/10 border-destructive/20 text-destructive"
              )}
            >
              <span>{testStatus.success ? "✓" : "✕"} {testStatus.message}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">SSH Password</Label>
            <div className="relative">
              <Input
                type={showPass ? "text" : "password"}
                placeholder="Enter SSH password for remote host"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10 font-mono text-sm"
                autoFocus
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPass(!showPass)}
                tabIndex={-1}
              >
                {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              This password will be encrypted using the Master Credential Vault and used for SSH login and sudo elevation.
            </p>
          </div>

          <DialogFooter className="flex items-center justify-between sm:justify-between gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs gap-1.5"
              onClick={handleTest}
              disabled={testing || !password}
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />}
              Test Login
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="text-xs gap-1.5"
                disabled={saving || !password}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save to Vault
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------
// Sub-Card: Automated System Updates (Unattended-Upgrades)
// ----------------------------------------------------------------------
function AutoUpdateCard({ serverId }: { serverId: number }) {
  const queryClient = useQueryClient();
  const { data: updateData, isLoading, refetch } = useQuery({
    queryKey: autoUpdateKeys.detail(serverId),
    queryFn: () => fetchAutoUpdateStatus(serverId),
  });

  const [actionPending, setActionPending] = useState<string | null>(null);

  const handleAction = async (action: "enable" | "disable" | "remove") => {
    setActionPending(action);
    try {
      const res = await updateAutoUpdateStatus(serverId, { action });
      toast.success(res.message);
      queryClient.invalidateQueries({ queryKey: autoUpdateKeys.detail(serverId) });
    } catch (err: any) {
      toast.error(err.message || `Failed to ${action} auto-update`);
    } finally {
      setActionPending(null);
    }
  };

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-blue-500" />
          System Auto-Update & Upgrade Status (Unattended-Upgrades)
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={() => refetch()}
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking unattended-upgrades configuration...
          </div>
        ) : !updateData ? (
          <p className="text-xs text-muted-foreground">Unable to inspect auto-update status.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
              <div className="p-2 rounded-lg bg-muted/40 border">
                <div className="text-[10px] text-muted-foreground uppercase">Installed</div>
                <div className="text-xs font-semibold mt-0.5">
                  {updateData.installed ? (
                    <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">
                      Installed ({updateData.packageManager})
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] border-rose-500/30 text-rose-400">
                      Not Installed
                    </Badge>
                  )}
                </div>
              </div>

              <div className="p-2 rounded-lg bg-muted/40 border">
                <div className="text-[10px] text-muted-foreground uppercase">Auto-Upgrade Config</div>
                <div className="text-xs font-semibold mt-0.5">
                  {updateData.enabled ? (
                    <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">
                      Enabled (Periodic)
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
                      Disabled
                    </Badge>
                  )}
                </div>
              </div>

              <div className="p-2 rounded-lg bg-muted/40 border">
                <div className="text-[10px] text-muted-foreground uppercase">Service State</div>
                <div className="text-xs font-semibold mt-0.5">
                  {updateData.active ? (
                    <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">
                      Active (systemd)
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] border-zinc-500/30 text-zinc-400">
                      {updateData.serviceStatus}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="p-2 rounded-lg bg-muted/40 border">
                <div className="text-[10px] text-muted-foreground uppercase">Package List Sync</div>
                <div className="text-xs font-semibold mt-0.5 font-mono text-[11px]">
                  {updateData.updatePackageLists ? "Daily (Active)" : "Inactive"}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-2 pt-1 border-t border-border/40">
              <div className="text-xs text-muted-foreground">
                Automated security patching and debian package upgrades on host.
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                  onClick={() => handleAction("enable")}
                  disabled={actionPending !== null}
                >
                  {actionPending === "enable" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                  Enable Auto-Updates
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1 text-amber-500 hover:text-amber-400 hover:bg-amber-500/10"
                  onClick={() => handleAction("disable")}
                  disabled={actionPending !== null}
                >
                  {actionPending === "disable" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldAlert className="h-3 w-3" />}
                  Disable
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => handleAction("remove")}
                  disabled={actionPending !== null}
                >
                  {actionPending === "remove" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  Purge from Host
                </Button>
              </div>
            </div>

            
          </>
        )}
      </CardContent>
    </Card>
  );
}


// ----------------------------------------------------------------------
// Sub-Card: Alert Channels & Live Notification Dispatcher (CloudScope Integration)
// ----------------------------------------------------------------------
function AlertChannelsCard({ serverId }: { serverId: number }) {
  const { data: channels, isLoading } = useQuery({
    queryKey: alertChannelKeys.detail(serverId),
    queryFn: () => fetchServerAlertChannels(serverId),
  });

  const [dispatching, setDispatching] = useState(false);

  const handleTestAlert = async () => {
    setDispatching(true);
    try {
      const res = await sendServerTestAlert(serverId);
      toast.success(res.message);
    } catch (err: any) {
      toast.error(err.message || "Failed to dispatch test alert");
    } finally {
      setDispatching(false);
    }
  };

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Bell className="h-4 w-4 text-amber-500" />
          Alert Channels & Live Notification Dispatcher (CloudScope Feature)
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1.5"
          onClick={handleTestAlert}
          disabled={dispatching}
        >
          {dispatching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5 text-amber-500" />}
          Dispatch Test Alert
        </Button>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        <div className="text-xs text-muted-foreground">
          When this server transitions states (UP ➔ DOWN or DOWN ➔ UP), RackMap automatically dispatches notifications across configured external webhooks and chat bots.
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking notification channels...
          </div>
        ) : !channels ? (
          <p className="text-xs text-muted-foreground">Notification channels status unavailable.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
            {/* Webhook */}
            <div className="p-3 rounded-lg bg-muted/40 border space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Discord / Slack Webhook</span>
                {channels.webhook.configured ? (
                  <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">Configured</Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] border-zinc-500/30 text-zinc-400">Inactive</Badge>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground font-mono truncate">
                {channels.webhook.urlMasked || "NOTIFY_WEBHOOK_URL unset"}
              </div>
            </div>

            {/* Telegram */}
            <div className="p-3 rounded-lg bg-muted/40 border space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Telegram Alert Bot</span>
                {channels.telegram.configured ? (
                  <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">Configured</Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] border-zinc-500/30 text-zinc-400">Inactive</Badge>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground font-mono truncate">
                {channels.telegram.chatId ? `Chat ID: ${channels.telegram.chatId}` : "NOTIFY_TELEGRAM_BOT_TOKEN unset"}
              </div>
            </div>

            {/* Email */}
            <div className="p-3 rounded-lg bg-muted/40 border space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Email Alerts (SMTP)</span>
                {channels.email.configured ? (
                  <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">Configured</Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] border-zinc-500/30 text-zinc-400">Inactive</Badge>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground font-mono truncate">
                {channels.email.host ? `Host: ${channels.email.host}` : "SMTP_HOST unset"}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------
// TAB 2: Live Metrics (5s polling)
// ----------------------------------------------------------------------
function LiveMetricsTab({ serverId }: { serverId: number }) {
  const metricsQ = useQuery({
    queryKey: serverKeys.metrics(serverId),
    queryFn: () => fetchServerMetrics(serverId),
    refetchInterval: 5000,
    retry: false,
  });

  const m = metricsQ.data;
  const cpuLoadPct = m ? (m.cpu.loadAvg1 / Math.max(1, m.cpu.cores)) * 100 : 0;
  const memPct = m && m.mem.totalMb > 0 ? (m.mem.usedMb / m.mem.totalMb) * 100 : 0;

  if (metricsQ.isLoading) {
    return (
      <div className="h-64 flex items-center justify-center gap-2 text-muted-foreground text-xs">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Collecting live telemetry over SSH socket...</span>
      </div>
    );
  }

  if (!m) {
    return (
      <div className="p-8 text-center space-y-2 border rounded-xl bg-card">
        <AlertCircle className="h-8 w-8 text-amber-500 mx-auto" />
        <h3 className="text-sm font-semibold">Real-time metrics unavailable</h3>
        <p className="text-xs text-muted-foreground">
          Unable to fetch live metrics over SSH. Ensure the server is online and SSH credentials are valid.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* CPU */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Cpu className="h-4 w-4 text-blue-500" /> CPU Telemetry & Top Processes
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Load: <strong className="font-mono text-foreground">{m.cpu.loadAvg1.toFixed(2)} / {m.cpu.loadAvg5.toFixed(2)} / {m.cpu.loadAvg15.toFixed(2)}</strong>
              </span>
              <span>{m.cpu.cores} physical cores</span>
            </div>
            <Bar pct={cpuLoadPct} color={cpuLoadPct > 90 ? "bg-red-500" : cpuLoadPct > 70 ? "bg-yellow-500" : "bg-blue-500"} />
            <ProcTable procs={m.topCpu} kind="cpu" />
          </CardContent>
        </Card>

        {/* Memory */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <MemoryStick className="h-4 w-4 text-emerald-500" /> Memory Telemetry & Top Processes
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-mono text-foreground font-medium">
                {(m.mem.usedMb / 1024).toFixed(1)} / {(m.mem.totalMb / 1024).toFixed(1)} GB
              </span>
              <span className="font-mono">{memPct.toFixed(0)}% utilized</span>
            </div>
            <Bar pct={memPct} color={memPct > 90 ? "bg-red-500" : memPct > 70 ? "bg-yellow-500" : "bg-emerald-500"} />
            <ProcTable procs={m.topMem} kind="mem" />
          </CardContent>
        </Card>

        {/* Storage Filesystems */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-amber-500" /> Mounted Filesystems
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-2">
            {m.disks.length === 0 ? (
              <p className="text-xs text-muted-foreground">No mounted filesystems found</p>
            ) : (
              m.disks.map((d) => (
                <div key={d.mount} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-medium">{d.mount}</span>
                    <span className="text-muted-foreground font-mono">
                      {fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)} ({d.pct}%)
                    </span>
                  </div>
                  <Bar pct={d.pct} color={d.pct > 90 ? "bg-red-500" : d.pct > 75 ? "bg-yellow-500" : "bg-amber-500"} />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Network Interfaces */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Network className="h-4 w-4 text-purple-500" /> Network Traffic Rates
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {m.net.length === 0 ? (
              <p className="text-xs text-muted-foreground">No network interfaces reporting</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground text-[10px]">
                    <th className="text-left font-medium pb-1">Interface</th>
                    <th className="text-right font-medium pb-1">↓ Inbound (RX)</th>
                    <th className="text-right font-medium pb-1">↑ Outbound (TX)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40 font-mono text-[11px]">
                  {m.net.map((n) => (
                    <tr key={n.iface}>
                      <td className="py-1 font-medium">{n.iface}</td>
                      <td className="py-1 text-right text-emerald-500">{fmtBytes(n.rxBytesPerSec)}/s</td>
                      <td className="py-1 text-right text-blue-500">{fmtBytes(n.txBytesPerSec)}/s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Multi-Vendor GPU Telemetry (NVIDIA / AMD / Intel) */}
        <Card className="lg:col-span-2">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-purple-500" /> Multi-Vendor GPU Telemetry (NVIDIA / AMD / Intel)
              </span>
              <Badge variant="secondary" className="text-[10px] font-mono">
                {m.hasGpu ? `${m.gpus.length} Device(s) Active` : "No GPU Active"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-4">
            {!m.hasGpu ? (
              <p className="text-xs text-muted-foreground py-2">
                No active GPU accelerators detected (Checked: nvidia-smi, AMD sysfs/amdgpu, AMD ROCm, Intel xpu-smi).
              </p>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {m.gpus.map((g) => {
                    const vramPct = g.memTotalMb > 0 ? (g.memUsedMb / g.memTotalMb) * 100 : 0;
                    return (
                      <div key={g.index} className="p-3 rounded-lg border bg-muted/20 space-y-2.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-foreground font-mono">
                            #{g.index} {g.name}
                          </span>
                          <span className="text-muted-foreground font-mono text-[11px]">
                            {g.utilPct}% Util {g.tempC != null ? `· ${g.tempC}°C` : ""}
                          </span>
                        </div>
                        <Bar pct={g.utilPct} color={g.utilPct > 90 ? "bg-red-500" : g.utilPct > 70 ? "bg-yellow-500" : "bg-purple-500"} />
                        <div className="space-y-1 pt-1">
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span>VRAM Utilization</span>
                            <span className="font-mono">
                              {(g.memUsedMb / 1024).toFixed(1)} / {(g.memTotalMb / 1024).toFixed(1)} GB ({vramPct.toFixed(0)}%)
                            </span>
                          </div>
                          <Bar pct={vramPct} color="bg-fuchsia-500" />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* GPU Compute Processes */}
                {m.gpuProcs && m.gpuProcs.length > 0 && (
                  <div className="space-y-1.5 border-t border-border/50 pt-3">
                    <div className="text-xs font-semibold text-muted-foreground">Active GPU Compute Processes</div>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground text-[10px] border-b">
                          <th className="text-left font-medium pb-1">PID</th>
                          <th className="text-left font-medium pb-1">Process Name</th>
                          <th className="text-right font-medium pb-1">VRAM Used</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40 font-mono text-[11px]">
                        {m.gpuProcs.map((gp) => (
                          <tr key={gp.pid}>
                            <td className="py-1 text-muted-foreground">{gp.pid}</td>
                            <td className="py-1 font-medium">{gp.name}</td>
                            <td className="py-1 text-right text-purple-400">{gp.memMb} MB</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-[11px] text-muted-foreground text-right">
        Auto-refreshes every 5 seconds · Collected at {new Date(m.collectedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}

// ----------------------------------------------------------------------
// TAB 3: ATOP History & Spikes Analysis
// ----------------------------------------------------------------------

function TopProcessCategoryCard({
  title,
  icon: Icon,
  iconColor,
  barColor,
  processes,
  type,
  isLoading,
}: {
  title: string;
  icon: any;
  iconColor: string;
  barColor: string;
  processes: AtopProcess[];
  type: "cpu" | "mem" | "dsk" | "net";
  isLoading?: boolean;
}) {
  return (
    <Card className="bg-card/70 backdrop-blur border shadow-sm flex flex-col justify-between">
      <CardHeader className="p-3 pb-2 border-b border-border/40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn("p-1.5 rounded-md bg-muted/60", iconColor)}>
              <Icon className="h-4 w-4" />
            </div>
            <CardTitle className="text-xs font-semibold">{title}</CardTitle>
          </div>
          <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0 h-4">
            Top {processes.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-3 space-y-2 flex-1 flex flex-col justify-start">
        {isLoading ? (
          <div className="py-8 flex items-center justify-center gap-2 text-muted-foreground text-xs">
            <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
            <span>Loading processes...</span>
          </div>
        ) : processes.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No processes recorded for this interval.
          </div>
        ) : (
          processes.map((p, idx) => (
            <div
              key={`${p.pid}-${idx}`}
              className="p-2 rounded-lg bg-muted/30 border border-border/30 hover:border-border/70 transition-colors space-y-1"
            >
              <div className="flex items-center justify-between gap-1.5 text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold font-mono text-foreground truncate max-w-[120px]" title={p.name}>
                    {p.name}
                  </span>
                  <Badge variant="outline" className="text-[9px] font-mono px-1 py-0 h-4 shrink-0 text-muted-foreground">
                    #{p.pid}
                  </Badge>
                </div>
                <span className="font-mono text-[11px] font-bold text-foreground shrink-0">
                  {p.value}
                </span>
              </div>
              <div className="h-1.5 w-full bg-muted/80 rounded-full overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all duration-300", barColor)}
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(
                        8,
                        type === "cpu"
                          ? p.cpuPct
                          : type === "mem"
                          ? p.memPct * 3
                          : type === "dsk"
                          ? p.dskPct
                          : (parseInt(p.netRate, 10) || 1) * 15
                      )
                    )}%`,
                  }}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function AtopTab({
  serverId,
  onSelectSnapshot,
}: {
  serverId: number;
  onSelectSnapshot: (snap: AtopIntervalSnapshot) => void;
}) {
  const { data: datesData, isLoading: datesLoading } = useQuery({
    queryKey: serverKeys.atopDates(serverId),
    queryFn: () => fetchAtopDates(serverId),
  });

  const availableDates = datesData?.dates ?? [];
  const [selectedDate, setSelectedDate] = useState<string>("");

  const activeDate = selectedDate || (availableDates.length > 0 ? availableDates[0] : "");

  // Date Navigation
  const currentDateIndex = availableDates.indexOf(activeDate);
  const canGoOlderDate = currentDateIndex >= 0 && currentDateIndex < availableDates.length - 1;
  const canGoNewerDate = currentDateIndex > 0;

  // Selected interval state (null = whole day)
  const [selectedInterval, setSelectedInterval] = useState<AtopIntervalSnapshot | null>(null);

  const [metricFilter, setMetricFilter] = useState<"all" | "cpu" | "mem" | "dsk" | "net">("all");
  const [cpuThreshold, setCpuThreshold] = useState<number>(70);
  const [memThreshold, setMemThreshold] = useState<number>(80);
  const [diskThreshold, setDiskThreshold] = useState<number>(60);
  const [fromTime, setFromTime] = useState<string>("");
  const [toTime, setToTime] = useState<string>("");

  const queryPayload: AtopQueryInput = useMemo(
    () => ({
      date: activeDate || undefined,
      timeFrom: fromTime || undefined,
      timeTo: toTime || undefined,
      metricFilter,
      cpuThreshold,
      memThreshold,
      dskThreshold: diskThreshold,
    }),
    [activeDate, fromTime, toTime, metricFilter, cpuThreshold, memThreshold, diskThreshold]
  );

  const { data: snapshotsData, isLoading: snapshotsLoading, refetch } = useQuery({
    queryKey: ["servers", serverId, "atop-snapshots", queryPayload],
    queryFn: () => fetchAtopSnapshots(serverId, queryPayload),
    enabled: !!activeDate,
  });

  const snapshots = snapshotsData?.snapshots ?? [];
  const totalSnapshots = snapshotsData?.total ?? 0;
  const spikeCount = snapshotsData?.spikesCount ?? 0;

  // Time Interval Navigation
  const activeSnapshotIndex = selectedInterval
    ? snapshots.findIndex((s) => s.timestamp === selectedInterval.timestamp)
    : -1;

  const canPrevTime = selectedInterval ? activeSnapshotIndex > 0 : snapshots.length > 0;
  const canNextTime = selectedInterval ? activeSnapshotIndex >= 0 && activeSnapshotIndex < snapshots.length - 1 : snapshots.length > 0;

  const handlePrevTime = () => {
    if (snapshots.length === 0) return;
    if (activeSnapshotIndex > 0) {
      setSelectedInterval(snapshots[activeSnapshotIndex - 1]);
    } else if (activeSnapshotIndex === -1) {
      setSelectedInterval(snapshots[0]);
    }
  };

  const handleNextTime = () => {
    if (snapshots.length === 0) return;
    if (activeSnapshotIndex >= 0 && activeSnapshotIndex < snapshots.length - 1) {
      setSelectedInterval(snapshots[activeSnapshotIndex + 1]);
    } else if (activeSnapshotIndex === -1) {
      setSelectedInterval(snapshots[0]);
    }
  };

  // Interval-specific Top Processes Query
  const selectedTime = selectedInterval
    ? (selectedInterval.dateTime.split(" ")[1] || selectedInterval.dateTime)
    : undefined;

  const { data: intervalTopData, isLoading: intervalTopLoading } = useQuery({
    queryKey: serverKeys.atopTopProcesses(serverId, activeDate, selectedTime),
    queryFn: () => fetchAtopTopProcesses(serverId, activeDate, selectedTime),
    enabled: !!activeDate && !!selectedTime,
  });

  // Active top processes: Interval-specific if selected, otherwise whole day default from snapshotsData
  const activeTopProcesses: AtopTopProcesses | undefined = selectedInterval
    ? (intervalTopData?.topProcesses || (selectedInterval.topProcesses ? {
        cpu: intervalTopData?.topProcesses?.cpu || [],
        mem: intervalTopData?.topProcesses?.mem || [],
        dsk: intervalTopData?.topProcesses?.dsk || [],
        net: intervalTopData?.topProcesses?.net || [],
      } : undefined))
    : snapshotsData?.topProcesses;

  const isProcsLoading = selectedInterval ? intervalTopLoading : snapshotsLoading;

  // Compute peak usages from snapshot array
  const peaks = useMemo(() => {
    if (snapshots.length === 0) return null;
    let maxCpu = snapshots[0];
    let maxMem = snapshots[0];
    let maxDsk = snapshots[0];
    let maxNet = snapshots[0];

    for (const s of snapshots) {
      if (s.cpu.totalPct > maxCpu.cpu.totalPct) maxCpu = s;
      if (s.mem.usedPct > maxMem.mem.usedPct) maxMem = s;
      if (s.dsk.busyPct > maxDsk.dsk.busyPct) maxDsk = s;
      if (s.net.inKbps + s.net.outKbps > maxNet.net.inKbps + maxNet.net.outKbps) maxNet = s;
    }
    return {
      cpu: { val: maxCpu.cpu.totalPct, time: maxCpu.dateTime },
      mem: { val: maxMem.mem.usedPct, time: maxMem.dateTime },
      dsk: { val: maxDsk.dsk.busyPct, time: maxDsk.dateTime },
      net: { val: maxNet.net.inKbps + maxNet.net.outKbps, time: maxNet.dateTime },
    };
  }, [snapshots]);

  return (
    <div className="space-y-4">
      {/* ATOP Not Installed Alert Banner */}
      {datesData && !datesData.installed && (
        <div className="p-4 rounded-xl border border-amber-500/40 bg-amber-500/10 space-y-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-amber-500/20 text-amber-500 mt-0.5">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-foreground">ATOP is not installed on this server</h4>
              <p className="text-xs text-muted-foreground">
                Historical performance logging and spike analysis require the <code className="text-foreground font-mono">atop</code> service to be installed and active on the target machine.
              </p>
            </div>
          </div>
          <div className="p-3 rounded-lg bg-background/90 border font-mono text-xs text-muted-foreground space-y-1.5">
            <div className="text-[11px] font-medium text-foreground">To install and enable ATOP on Ubuntu / Debian:</div>
            <div className="flex items-center justify-between gap-2 text-foreground select-all bg-muted/40 p-2 rounded">
              <span className="truncate">sudo apt update && sudo apt install -y atop && sudo systemctl enable --now atop</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px] shrink-0 gap-1"
                onClick={() => {
                  navigator.clipboard.writeText("sudo apt update && sudo apt install -y atop && sudo systemctl enable --now atop");
                  toast.success("Install command copied to clipboard");
                }}
              >
                <Copy className="h-3 w-3" /> Copy
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground pt-0.5">
              For RHEL / Rocky Linux: <code className="text-foreground">sudo dnf install -y atop && sudo systemctl enable --now atop</code>
            </div>
          </div>
        </div>
      )}

      {/* Installed but No Archives Banner */}
      {datesData && datesData.installed && availableDates.length === 0 && (
        <div className="p-4 rounded-xl border border-blue-500/30 bg-blue-500/10 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-blue-400 shrink-0" />
          <div className="text-xs space-y-0.5">
            <p className="font-semibold text-foreground">ATOP service is installed, but no daily archives have been recorded yet</p>
            <p className="text-muted-foreground">The ATOP background daemon will periodically write snapshots to <code className="font-mono">/var/log/atop/atop_YYYYMMDD</code> as it monitors system activity.</p>
          </div>
        </div>
      )}

      {/* Controls & Filters */}
      <div className="p-4 rounded-xl border bg-card/70 backdrop-blur space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
              <Flame className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2">
                ATOP Historical Snapshot & Spike Analyzer
                <Badge variant="outline" className="text-[10px] font-mono">
                  Archive logs: /var/log/atop/atop_*
                </Badge>
              </h3>
              <p className="text-xs text-muted-foreground">
                Inspect historical CPU, Memory, Disk IO, and Network load spikes with process attribution.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Archive Date Selector with Prev / Next Day Controls */}
            <div className="flex items-center gap-1">
              <Label className="text-xs text-muted-foreground mr-0.5">Date:</Label>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                disabled={!canGoOlderDate}
                onClick={() => {
                  if (canGoOlderDate) {
                    setSelectedDate(availableDates[currentDateIndex + 1]);
                    setSelectedInterval(null);
                  }
                }}
                title="Previous Day (Older)"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <Select
                value={activeDate}
                onValueChange={(v) => {
                  setSelectedDate(v);
                  setSelectedInterval(null);
                }}
              >
                <SelectTrigger className="h-8 text-xs font-mono w-[130px]">
                  <SelectValue placeholder="Select Date" />
                </SelectTrigger>
                <SelectContent>
                  {datesLoading ? (
                    <SelectItem value="loading" disabled className="text-xs">Loading dates...</SelectItem>
                  ) : availableDates.length === 0 ? (
                    <SelectItem value="none" disabled className="text-xs">No logs found</SelectItem>
                  ) : (
                    availableDates.map((d) => (
                      <SelectItem key={d} value={d} className="text-xs font-mono">
                        {d}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>

              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                disabled={!canGoNewerDate}
                onClick={() => {
                  if (canGoNewerDate) {
                    setSelectedDate(availableDates[currentDateIndex - 1]);
                    setSelectedInterval(null);
                  }
                }}
                title="Next Day (Newer)"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            {/* Metric Filter */}
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Focus:</Label>
              <Select value={metricFilter} onValueChange={(v: any) => setMetricFilter(v)}>
                <SelectTrigger className="h-8 text-xs w-[130px]">
                  <SelectValue placeholder="Metric" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">All Snapshots</SelectItem>
                  <SelectItem value="cpu" className="text-xs">CPU Spikes (≥{cpuThreshold}%)</SelectItem>
                  <SelectItem value="mem" className="text-xs">Memory Spikes (≥{memThreshold}%)</SelectItem>
                  <SelectItem value="dsk" className="text-xs">Disk Spikes (≥{diskThreshold}%)</SelectItem>
                  <SelectItem value="net" className="text-xs">Network Spikes</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>

        {/* Secondary filters row */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-border/50 text-xs">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">From Time (HH:MM)</Label>
            <Input
              value={fromTime}
              onChange={(e) => setFromTime(e.target.value)}
              placeholder="e.g. 14:00"
              className="h-7 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">To Time (HH:MM)</Label>
            <Input
              value={toTime}
              onChange={(e) => setToTime(e.target.value)}
              placeholder="e.g. 18:00"
              className="h-7 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">CPU Spike %</Label>
            <Input
              type="number"
              value={cpuThreshold}
              onChange={(e) => setCpuThreshold(Number(e.target.value))}
              className="h-7 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Mem Spike %</Label>
            <Input
              type="number"
              value={memThreshold}
              onChange={(e) => setMemThreshold(Number(e.target.value))}
              className="h-7 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Disk Spike %</Label>
            <Input
              type="number"
              value={diskThreshold}
              onChange={(e) => setDiskThreshold(Number(e.target.value))}
              className="h-7 text-xs font-mono"
            />
          </div>
        </div>
      </div>

      {/* Time Interval Stepper & Navigation Bar */}
      <div className="flex items-center justify-between flex-wrap gap-2 p-3 rounded-xl border bg-muted/20 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-amber-500/10 text-amber-500">
            <Clock className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-foreground">Time Interval:</span>
            {selectedInterval ? (
              <Badge variant="secondary" className="font-mono text-xs px-2.5 py-0.5 bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                {selectedInterval.dateTime} ({activeSnapshotIndex + 1} of {snapshots.length})
              </Badge>
            ) : (
              <Badge variant="outline" className="font-mono text-xs px-2.5 py-0.5 text-muted-foreground flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-amber-400" />
                Whole Day Activity (Default)
              </Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1 px-2.5"
              disabled={!canPrevTime}
              onClick={handlePrevTime}
              title="Previous Time Interval"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Prev Time</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1 px-2.5"
              disabled={!canNextTime}
              onClick={handleNextTime}
              title="Next Time Interval"
            >
              <span>Next Time</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>

          {selectedInterval && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground hover:text-foreground gap-1 px-2"
              onClick={() => setSelectedInterval(null)}
              title="Reset to whole day summary"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Whole Day</span>
            </Button>
          )}
        </div>
      </div>

      {/* Top 5 Processes Section: Memory, CPU, Disk, Network */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-amber-500" />
            Top 5 Resource Consumers {selectedInterval ? `at ${selectedInterval.dateTime}` : `for Day ${activeDate} (Default)`}
          </h4>
          <span className="text-[11px] text-muted-foreground">
            {selectedInterval ? "Interval-specific top consumers" : "Aggregated day-level top consumers"}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <TopProcessCategoryCard
            title="Top 5 CPU"
            icon={Cpu}
            iconColor="text-amber-500"
            barColor="bg-amber-500"
            processes={activeTopProcesses?.cpu ?? []}
            type="cpu"
            isLoading={isProcsLoading}
          />
          <TopProcessCategoryCard
            title="Top 5 Memory"
            icon={MemoryStick}
            iconColor="text-emerald-500"
            barColor="bg-emerald-500"
            processes={activeTopProcesses?.mem ?? []}
            type="mem"
            isLoading={isProcsLoading}
          />
          <TopProcessCategoryCard
            title="Top 5 Disk I/O"
            icon={HardDrive}
            iconColor="text-blue-500"
            barColor="bg-blue-500"
            processes={activeTopProcesses?.dsk ?? []}
            type="dsk"
            isLoading={isProcsLoading}
          />
          <TopProcessCategoryCard
            title="Top 5 Network Sockets"
            icon={Network}
            iconColor="text-purple-500"
            barColor="bg-purple-500"
            processes={activeTopProcesses?.net ?? []}
            type="net"
            isLoading={isProcsLoading}
          />
        </div>
      </div>

      {/* Peak Usage Summary KPI Cards */}
      {peaks && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="bg-muted/20 border">
            <CardContent className="p-3">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
                <Cpu className="h-3 w-3 text-amber-500" /> Peak CPU Total
              </span>
              <div className="text-base font-bold font-mono text-foreground mt-0.5">
                {peaks.cpu.val.toFixed(1)}%
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">at {peaks.cpu.time}</span>
            </CardContent>
          </Card>

          <Card className="bg-muted/20 border">
            <CardContent className="p-3">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
                <MemoryStick className="h-3 w-3 text-emerald-500" /> Peak Memory Usage
              </span>
              <div className="text-base font-bold font-mono text-foreground mt-0.5">
                {peaks.mem.val.toFixed(1)}%
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">at {peaks.mem.time}</span>
            </CardContent>
          </Card>

          <Card className="bg-muted/20 border">
            <CardContent className="p-3">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
                <HardDrive className="h-3 w-3 text-blue-500" /> Peak Disk Utilization
              </span>
              <div className="text-base font-bold font-mono text-foreground mt-0.5">
                {peaks.dsk.val.toFixed(1)}%
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">at {peaks.dsk.time}</span>
            </CardContent>
          </Card>

          <Card className="bg-muted/20 border">
            <CardContent className="p-3">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
                <Network className="h-3 w-3 text-purple-500" /> Peak Network Rate
              </span>
              <div className="text-base font-bold font-mono text-foreground mt-0.5">
                {(peaks.net.val / 1024).toFixed(1)} Mbps
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">at {peaks.net.time}</span>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Snapshots Timeline Table */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Interval Snapshots ({snapshots.length} shown of {totalSnapshots} total · {spikeCount} spikes detected)
            </CardTitle>
            <span className="text-[11px] text-muted-foreground">
              Click any interval to update top processes & drill down
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {snapshotsLoading ? (
              <div className="py-12 flex items-center justify-center gap-2 text-muted-foreground text-xs">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Reading raw atop snapshots from log archive...</span>
              </div>
            ) : snapshots.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-xs">
                No snapshots match the current filters. Adjust your thresholds or time range.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground text-[10px]">
                    <th className="py-2 px-3 text-left font-medium">Date & Time</th>
                    <th className="py-2 px-3 text-right font-medium">Interval</th>
                    <th className="py-2 px-3 text-right font-medium">CPU Total</th>
                    <th className="py-2 px-3 text-right font-medium">CPU Sys/User</th>
                    <th className="py-2 px-3 text-right font-medium">Mem Used</th>
                    <th className="py-2 px-3 text-right font-medium">Disk Busy</th>
                    <th className="py-2 px-3 text-right font-medium">Disk Sectors</th>
                    <th className="py-2 px-3 text-right font-medium">Net In / Out</th>
                    <th className="py-2 px-3 text-center font-medium">Anomalies / Spikes</th>
                    <th className="py-2 px-3 text-center font-medium">Drill-Down</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30 font-mono text-[11px]">
                  {snapshots.map((s, idx) => {
                    const hasSpike = s.spikes.isCpuSpike || s.spikes.isMemSpike || s.spikes.isDskSpike || s.spikes.isNetSpike;
                    const isSelected = selectedInterval?.timestamp === s.timestamp;
                    return (
                      <tr
                        key={`${s.dateTime}-${idx}`}
                        className={cn(
                          "cursor-pointer transition-colors hover:bg-muted/40",
                          isSelected && "bg-amber-500/15 border-l-4 border-l-amber-500 font-semibold",
                          hasSpike && !isSelected && "bg-amber-500/5 hover:bg-amber-500/10"
                        )}
                        onClick={() => setSelectedInterval(s)}
                      >
                        <td className="py-2 px-3 font-semibold text-foreground flex items-center gap-1.5">
                          {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 animate-pulse" />}
                          {s.dateTime}
                        </td>
                        <td className="py-2 px-3 text-right text-muted-foreground">{s.elapsedSeconds}s</td>
                        <td className={cn("py-2 px-3 text-right font-semibold", s.spikes.isCpuSpike ? "text-red-500" : "text-foreground")}>
                          {s.cpu.totalPct.toFixed(1)}%
                        </td>
                        <td className="py-2 px-3 text-right text-muted-foreground text-[10px]">
                          {s.cpu.sysPct}% / {s.cpu.userPct}%
                        </td>
                        <td className={cn("py-2 px-3 text-right font-medium", s.spikes.isMemSpike ? "text-red-500" : "text-muted-foreground")}>
                          {s.mem.usedPct.toFixed(0)}%
                        </td>
                        <td className={cn("py-2 px-3 text-right font-medium", s.spikes.isDskSpike ? "text-amber-500" : "text-muted-foreground")}>
                          {s.dsk.busyPct.toFixed(1)}%
                        </td>
                        <td className="py-2 px-3 text-right text-muted-foreground text-[10px]">
                          {s.dsk.readSectors + s.dsk.writeSectors}
                        </td>
                        <td className={cn("py-2 px-3 text-right text-[10px]", s.spikes.isNetSpike ? "text-purple-400 font-bold" : "text-muted-foreground")}>
                          {s.net.inKbps} / {s.net.outKbps} Kbps
                        </td>
                        <td className="py-2 px-3 text-center">
                          <div className="flex items-center justify-center gap-1 flex-wrap">
                            {s.spikes.isCpuSpike && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-red-500/30 text-red-500">
                                CPU
                              </Badge>
                            )}
                            {s.spikes.isMemSpike && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-amber-500/30 text-amber-500">
                                MEM
                              </Badge>
                            )}
                            {s.spikes.isDskSpike && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-500">
                                DSK
                              </Badge>
                            )}
                            {s.spikes.isNetSpike && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-purple-500/30 text-purple-400">
                                NET
                              </Badge>
                            )}
                            {!hasSpike && <span className="text-[10px] text-muted-foreground">—</span>}
                          </div>
                        </td>
                        <td className="py-2 px-3 text-center">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px] gap-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedInterval(s);
                              onSelectSnapshot(s);
                            }}
                          >
                            Inspect
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


// TAB 4: Forensic Logs & Evidence Viewer
// ----------------------------------------------------------------------
function LogsViewerTab({ serverId }: { serverId: number }) {
  const [source, setSource] = useState<"journalctl" | "auth" | "syslog" | "dmesg">("journalctl");
  const [priority, setPriority] = useState<string>("all");
  const [unit, setUnit] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [since, setSince] = useState<string>("1 hour ago");
  const [lines, setLines] = useState<number>(100);

  // Auto Query Duration: 0 = manual, 5000 = 5s, 10000 = 10s, 30000 = 30s, 60000 = 60s
  const [autoQueryDuration, setAutoQueryDuration] = useState<number>(0);

  // Active query parameters (applied on clicking Query Logs or when auto-querying)
  const [appliedFilters, setAppliedFilters] = useState<LogQueryInput>({
    source: "journalctl",
    priority: undefined,
    unit: undefined,
    filterText: undefined,
    since: "1 hour ago",
    lines: 100,
  });

  const handleApplyQuery = () => {
    setAppliedFilters({
      source,
      priority: priority === "all" ? undefined : (priority as LogPriority),
      unit: unit.trim() || undefined,
      filterText: search.trim() || undefined,
      since: since.trim() || undefined,
      lines,
    });
    refetch();
  };

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["servers", serverId, "logs", appliedFilters],
    queryFn: () => queryServerLogs(serverId, appliedFilters),
    refetchInterval: autoQueryDuration > 0 ? autoQueryDuration : false,
  });

  const entries = data?.entries ?? [];

  const copyAllLogs = () => {
    if (entries.length === 0) return;
    const text = entries.map((l) => `${l.timestamp || ""} [${l.priority || "info"}] ${l.service ? `[${l.service}] ` : ""}${l.message}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      toast.success("All logs copied to clipboard");
    });
  };

  const downloadLogs = () => {
    if (entries.length === 0) return;
    const text = entries.map((l) => `${l.timestamp || ""} [${l.priority || "info"}] ${l.service ? `[${l.service}] ` : ""}${l.message}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `server_${serverId}_${source}_${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Search and filter toolbar */}
      <div className="p-4 rounded-xl border bg-card/70 backdrop-blur space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Forensic System Log Inspector</h3>
              <p className="text-xs text-muted-foreground">
                Query systemd journalctl, authentication events, kernel dmesg, and syslog with evidence search.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Auto Query Duration Selector */}
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Auto Query:</Label>
              <Select
                value={String(autoQueryDuration)}
                onValueChange={(val) => setAutoQueryDuration(Number(val))}
              >
                <SelectTrigger className="h-8 text-xs w-[135px] font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0" className="text-xs">Manual (Click)</SelectItem>
                  <SelectItem value="5000" className="text-xs font-mono">Auto: 5s</SelectItem>
                  <SelectItem value="10000" className="text-xs font-mono">Auto: 10s</SelectItem>
                  <SelectItem value="30000" className="text-xs font-mono">Auto: 30s</SelectItem>
                  <SelectItem value="60000" className="text-xs font-mono">Auto: 60s</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {autoQueryDuration > 0 && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 font-mono flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live ({autoQueryDuration / 1000}s)
              </Badge>
            )}

            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={copyAllLogs} disabled={entries.length === 0}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={downloadLogs} disabled={entries.length === 0}>
              <Download className="h-3.5 w-3.5" /> Export .log
            </Button>
            <Button
              size="sm"
              variant="default"
              className="h-8 text-xs gap-1.5"
              onClick={handleApplyQuery}
              disabled={isFetching}
            >
              {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Query Logs
            </Button>
          </div>
        </div>

        {/* Filter Inputs */}
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 pt-2 border-t border-border/50 text-xs">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Source</Label>
            <Select value={source} onValueChange={(v: any) => setSource(v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="journalctl" className="text-xs">journalctl (systemd)</SelectItem>
                <SelectItem value="auth" className="text-xs">/var/log/auth.log</SelectItem>
                <SelectItem value="syslog" className="text-xs">/var/log/syslog</SelectItem>
                <SelectItem value="dmesg" className="text-xs">dmesg (kernel)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Priority / Level</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All Priorities</SelectItem>
                <SelectItem value="emerg" className="text-xs text-red-500">Emergency (0)</SelectItem>
                <SelectItem value="alert" className="text-xs text-red-500">Alert (1)</SelectItem>
                <SelectItem value="crit" className="text-xs text-red-500">Critical (2)</SelectItem>
                <SelectItem value="err" className="text-xs text-rose-500">Error (3)</SelectItem>
                <SelectItem value="warning" className="text-xs text-amber-500">Warning (4)</SelectItem>
                <SelectItem value="notice" className="text-xs text-blue-400">Notice (5)</SelectItem>
                <SelectItem value="info" className="text-xs">Info (6)</SelectItem>
                <SelectItem value="debug" className="text-xs text-muted-foreground">Debug (7)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Service Unit</Label>
            <Input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="e.g. ssh, nginx, cron"
              className="h-8 text-xs font-mono"
              onKeyDown={(e) => { if (e.key === "Enter") handleApplyQuery(); }}
            />
          </div>

          <div className="space-y-1 col-span-2">
            <Label className="text-[11px] text-muted-foreground">Keyword / Evidence Search</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="e.g. Failed password, oom-killer, Accepted..."
                className="h-8 pl-7 text-xs font-mono"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Since / Time</Label>
            <Input
              value={since}
              onChange={(e) => setSince(e.target.value)}
              placeholder="e.g. 1 hour ago"
              className="h-8 text-xs font-mono"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Limit</Label>
            <Select value={String(lines)} onValueChange={(v) => setLines(Number(v))}>
              <SelectTrigger className="h-8 text-xs font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50" className="text-xs font-mono">50 lines</SelectItem>
                <SelectItem value="100" className="text-xs font-mono">100 lines</SelectItem>
                <SelectItem value="250" className="text-xs font-mono">250 lines</SelectItem>
                <SelectItem value="500" className="text-xs font-mono">500 lines</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Forensic Log Stream Console */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 font-mono text-xs overflow-hidden flex flex-col shadow-inner">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900/80 text-[11px] text-zinc-400">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Output: {entries.length} lines</span>
            {data?.total !== undefined && (
              <span>({data.total} matching filters)</span>
            )}
          </div>
          <span className="text-zinc-500 text-[10px]">Execute forensic audit logs</span>
        </div>

        <div className="p-3 overflow-x-auto max-h-[550px] overflow-y-auto divide-y divide-zinc-900 text-zinc-300">
          {isLoading ? (
            <div className="h-48 flex items-center justify-center gap-2 text-zinc-500 text-xs">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Querying remote system log streams over SSH...</span>
            </div>
          ) : entries.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-zinc-500 text-xs">
              No matching log entries found for this query filter.
            </div>
          ) : (
            entries.map((entry, idx) => {
              const isErr = entry.priority === "err" || entry.priority === "crit" || entry.priority === "emerg" || entry.priority === "alert";
              const isWarn = entry.priority === "warning";
              return (
                <div key={idx} className="py-1 flex items-start gap-2 hover:bg-zinc-900/50 text-[11px] leading-relaxed">
                  <span className="text-zinc-600 select-none shrink-0 w-8 text-right font-mono">{idx + 1}</span>
                  <span className="text-zinc-500 shrink-0 select-all">{entry.timestamp}</span>
                  {entry.service && (
                    <span className="text-blue-400 font-semibold shrink-0 select-all">[{entry.service}]</span>
                  )}
                  {entry.priority && (
                    <span
                      className={cn(
                        "text-[9px] uppercase px-1 rounded shrink-0 select-none",
                        isErr
                          ? "bg-red-950 text-red-400 border border-red-800"
                          : isWarn
                          ? "bg-amber-950 text-amber-400 border border-amber-800"
                          : "bg-zinc-800 text-zinc-400"
                      )}
                    >
                      {entry.priority}
                    </span>
                  )}
                  <span className={cn("flex-1 select-all break-all", isErr && "text-red-200", isWarn && "text-amber-200")}>
                    {entry.message}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// TAB 5: OS Users & Sudoers Permission Control
// ----------------------------------------------------------------------
function OsUsersTab({
  serverId,
  currentSshUser,
  onAddUser,
  onEditUser,
  onDeleteUser,
  onManageSudo,
}: {
  serverId: number;
  currentSshUser?: string;
  onAddUser: () => void;
  onEditUser: (user: OsUserInfo) => void;
  onDeleteUser: (user: OsUserInfo) => void;
  onManageSudo: (user: OsUserInfo) => void;
}) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: serverKeys.osUsers(serverId),
    queryFn: () => fetchServerOsUsers(serverId),
  });

  const users = useMemo(() => {
    return (data?.users ?? []).filter((u) => {
      if (!filter) return true;
      const f = filter.toLowerCase();
      return (
        u.username.toLowerCase().includes(f) ||
        u.homeDir.toLowerCase().includes(f) ||
        u.shell.toLowerCase().includes(f) ||
        (u.groups && u.groups.some((g) => g.toLowerCase().includes(f)))
      );
    });
  }, [data?.users, filter]);

  const totalUsers = data?.users?.length ?? 0;
  const sudoUsers = data?.users?.filter((u) => u.hasSudo)?.length ?? 0;
  const humanUsers = data?.users?.filter((u) => u.uid >= 1000)?.length ?? 0;

  // Pagination calculation
  const totalItems = users.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const paginatedUsers = useMemo(() => {
    const start = (page - 1) * pageSize;
    return users.slice(start, start + pageSize);
  }, [users, page, pageSize]);

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="p-4 rounded-xl border bg-card/70 backdrop-blur space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">OS Users & Sudoers Permission Control</h3>
              <p className="text-xs text-muted-foreground">
                Inspect and manage local Linux accounts, shells, home directories, and granular sudoers rules.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="default"
              className="h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={onAddUser}
            >
              <UserPlus className="h-3.5 w-3.5" /> + Add User
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh Users
            </Button>
          </div>
        </div>

        {/* Stats summary */}
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/50 text-xs">
          <div className="p-2 rounded bg-muted/40 border">
            <span className="text-[10px] text-muted-foreground uppercase">Total Accounts</span>
            <div className="text-base font-bold font-mono text-foreground">{totalUsers}</div>
          </div>
          <div className="p-2 rounded bg-muted/40 border">
            <span className="text-[10px] text-muted-foreground uppercase">Sudo Privileged</span>
            <div className="text-base font-bold font-mono text-amber-500">{sudoUsers}</div>
          </div>
          <div className="p-2 rounded bg-muted/40 border">
            <span className="text-[10px] text-muted-foreground uppercase">Human Accounts (UID ≥ 1000)</span>
            <div className="text-base font-bold font-mono text-emerald-500">{humanUsers}</div>
          </div>
        </div>
      </div>

      {/* Users table */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Local Accounts on Server ({totalItems} matching)
            </CardTitle>
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Filter by username, shell, group..."
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
                className="pl-8 h-8 text-xs font-mono"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {isLoading ? (
              <div className="py-12 flex items-center justify-center gap-2 text-muted-foreground text-xs">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Reading /etc/passwd and /etc/sudoers via SSH...</span>
              </div>
            ) : isError ? (
              <div className="py-12 text-center text-destructive text-xs gap-1.5 p-4">
                <AlertCircle className="h-5 w-5 mx-auto mb-1.5" />
                <span>{(error as any)?.message || "Failed to load OS users"}</span>
              </div>
            ) : paginatedUsers.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-xs">
                No accounts match filter criteria.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground text-[10px]">
                    <th className="py-2.5 px-3 text-left font-medium">Username</th>
                    <th className="py-2.5 px-3 text-left font-medium">UID : GID</th>
                    <th className="py-2.5 px-3 text-left font-medium">Home Directory</th>
                    <th className="py-2.5 px-3 text-left font-medium">Shell</th>
                    <th className="py-2.5 px-3 text-left font-medium">Groups</th>
                    <th className="py-2.5 px-3 text-left font-medium">Sudo Privileges</th>
                    <th className="py-2.5 px-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30 font-mono text-[11px]">
                  {paginatedUsers.map((u) => {
                    const isHuman = u.uid >= 1000;
                    const isSshUser = u.username === currentSshUser;
                    return (
                      <tr key={u.username} className="hover:bg-muted/30">
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-foreground">{u.username}</span>
                            {isSshUser && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 font-normal border-primary/40 text-primary">
                                SSH Admin
                              </Badge>
                            )}
                            {isHuman && (
                              <Badge variant="secondary" className="text-[9px] py-0 px-1 font-normal bg-emerald-500/10 text-emerald-500">
                                User
                              </Badge>
                            )}
                            {u.username === "root" && (
                              <Badge variant="destructive" className="text-[9px] py-0 px-1 font-normal">
                                Superuser
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground">
                          {u.uid} : {u.gid}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-foreground truncate max-w-[180px]" title={u.homeDir}>
                          {u.homeDir}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground truncate max-w-[140px]" title={u.shell}>
                          {u.shell}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground truncate max-w-[140px]" title={u.groups?.join(", ")}>
                          {u.groups?.length ? (
                            <span className="text-[10px]">{u.groups.slice(0, 3).join(", ")}{u.groups.length > 3 ? ` +${u.groups.length - 3}` : ""}</span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/60">—</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          {u.hasSudo ? (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Badge
                                variant="outline"
                                className="text-[10px] gap-1 bg-amber-500/10 text-amber-500 border-amber-500/30"
                              >
                                <ShieldCheck className="h-3 w-3" />
                                Sudo Granted
                              </Badge>
                              {u.sudoRules.length > 0 && (
                                <span className="text-[10px] text-muted-foreground truncate max-w-[150px]" title={u.sudoRules.join(" | ")}>
                                  {u.sudoRules[0]}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-[11px]">No Sudo Rights</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px] gap-1 px-2"
                              onClick={() => onManageSudo(u)}
                              title="Configure Sudo Permissions"
                            >
                              <ShieldCheck className="h-3 w-3 text-amber-500" /> Sudo
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px] gap-1 px-2"
                              onClick={() => onEditUser(u)}
                              title="Edit User Configuration"
                            >
                              <Pencil className="h-3 w-3 text-primary" /> Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px] gap-1 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => onDeleteUser(u)}
                              disabled={u.username === "root"}
                              title={u.username === "root" ? "Root account cannot be deleted" : "Delete User Account"}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {!isLoading && !isError && totalItems > 0 && (
            <PaginationBar
              page={page}
              totalPages={totalPages}
              totalItems={totalItems}
              pageSize={pageSize}
              onPageChange={(p) => setPage(p)}
              onPageSizeChange={(s) => {
                setPageSize(s);
                setPage(1);
              }}
              pageSizeOptions={[10, 25, 50, 100]}
              className="px-4 py-2 border-t"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
