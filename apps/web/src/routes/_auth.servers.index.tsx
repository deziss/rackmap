import { PaginationBar } from "@/components/pagination-bar";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { ServerDetailModal } from "@/components/server-detail-modal";
import { fetchServers, checkServer, checkAllServers, revealPassword, serverKeys } from "@/lib/queries";
import { apiFetch } from "@/lib/api";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  ExternalLink, RefreshCw, Eye, EyeOff, Trash2, RotateCcw, Zap,
  Download, AlertTriangle, Terminal, Copy, ShieldCheck,
} from "lucide-react";
import type { ServerDto } from "@inv/shared";
import { useDebounce } from "@/hooks/use-debounce";
import { ServerFormDialog } from "@/components/server-form-dialog";
import { SavedViews } from "@/components/saved-views";
import { ImportWizard } from "@/components/import-wizard";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/servers/")({
  component: ServersPage,
});

import { RequestAccessButton } from "@/components/request-access-button";

function DeleteConfirm({ server, onConfirm, isPending }: { server: ServerDto; onConfirm: () => void; isPending: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={() => setOpen(true)}
            disabled={isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete server</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex items-center justify-center h-10 w-10 rounded-full bg-destructive/15 shrink-0">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <AlertDialogTitle>Delete server?</AlertDialogTitle>
          </div>
          <AlertDialogDescription>
            <span className="font-mono text-foreground">{server.hostname}</span> will be soft-deleted.
            Restore is available from admin view.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ServersPage() {
  const qc = useQueryClient();
  const { data: session } = authClient.useSession();
  const role = (session?.user as { role?: string })?.role ?? "viewer";

  // me unused
  // sshEnabled unused

  const [q, setQ] = useState("");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [sortBy, setSortBy] = useState<string>("id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [detailServerId, setDetailServerId] = useState<number | null>(null);
  const [revealedPasswords, setRevealedPasswords] = useState<Record<number, string | null>>({});
  const debouncedQ = useDebounce(q, 300);

  const params = {
    q: debouncedQ || undefined,
    page,
    limit: pageSize,
    sortBy,
    sortDir,
    includeDeleted: includeDeleted || undefined,
  };

  const { data, isLoading, refetch } = useQuery({
    queryKey: serverKeys.list(params),
    queryFn: () => fetchServers(params as Record<string, string | number | boolean | undefined>),
    refetchInterval: 30_000,
  });

  const checkMutation = useMutation({
    mutationFn: checkServer,
    onSuccess: () => { qc.invalidateQueries({ queryKey: serverKeys.all }); toast.success("Check complete"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const checkAllMutation = useMutation({
    mutationFn: checkAllServers,
    onSuccess: (res) => { qc.invalidateQueries({ queryKey: serverKeys.all }); toast.success(`Checked ${res.checked} servers`); },
    onError: (e: Error) => toast.error(`Check all failed: ${e.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/v1/servers/${id}`, { method: "DELETE", credentials: "include" }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: serverKeys.all }); toast.success("Server deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/v1/servers/${id}/restore`, { method: "POST", credentials: "include" }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: serverKeys.all }); toast.success("Server restored"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleReveal = useCallback(
    async (server: ServerDto) => {
      if (revealedPasswords[server.id] !== undefined) {
        setRevealedPasswords((prev) => { const n = { ...prev }; delete n[server.id]; return n; });
        return;
      }
      try {
        const { password } = await revealPassword(server.id);
        setRevealedPasswords((prev) => ({ ...prev, [server.id]: password }));
        setTimeout(
          () => setRevealedPasswords((prev) => { const n = { ...prev }; delete n[server.id]; return n; }),
          30_000,
        );
      } catch (e: unknown) {
        toast.error((e as Error).message);
      }
    },
    [revealedPasswords],
  );

  const canEdit = role === "admin" || role === "editor";
  const isViewer = role === "viewer";

  async function triggerDownload(format: "xlsx" | "json", searchQ: string) {
    const url = `/api/v1/servers/export.${format}?q=${encodeURIComponent(searchQ)}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) { toast.error("Export failed"); return; }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `servers-${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch {
      toast.error("Export failed");
    }
  }

  // Viewer: fetch own access requests to derive per-server approval without N+1 calls
  const { data: myRequests } = useQuery({
    queryKey: ["access-requests", "mine"],
    queryFn: () => apiFetch<{ serverId: number; type: string; status: string; expiresAt: string | null }[]>("/api/v1/access-requests"),
    enabled: isViewer,
    refetchInterval: 15_000,
  });

  function viewerApproved(serverId: number, type: "ssh" | "password_reveal"): boolean {
    if (!isViewer || !myRequests) return false;
    const now = Date.now();
    return myRequests.some(
      (r) =>
        r.serverId === serverId &&
        r.type === type &&
        r.status === "approved" &&
        (r.expiresAt === null || new Date(r.expiresAt).getTime() > now),
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="sticky top-[-24px] z-30 -mx-6 px-6 pt-[24px] pb-4 bg-background/95 backdrop-blur-md border-b border-white/10 flex items-center gap-2.5 flex-wrap">
        <h1 className="text-xl font-semibold mr-auto tracking-tight">Servers</h1>
        <Input
          placeholder="Search hostname, IP, user…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          className="w-52 h-8 text-sm"
        />
        {role === "admin" && (
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
              className="accent-primary"
            />
            Show deleted
          </label>
        )}
        <SavedViews
          currentParams={{ q: debouncedQ, includeDeleted: String(includeDeleted) }}
          onLoad={(p) => { setQ(p.q ?? ""); setIncludeDeleted(p.includeDeleted === "true"); setPage(1); }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
        {canEdit && (
          <Button size="sm" variant="outline" className="gap-2" onClick={() => checkAllMutation.mutate()} disabled={checkAllMutation.isPending}>
            <RefreshCw className={`h-3.5 w-3.5 ${checkAllMutation.isPending ? "animate-spin" : ""}`} />
            Check All Health
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => triggerDownload("xlsx", debouncedQ)}
        >
          <Download className="h-3.5 w-3.5" /> XLSX
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => triggerDownload("json", debouncedQ)}
        >
          <Download className="h-3.5 w-3.5" /> JSON
        </Button>
        {canEdit && <ImportWizard onImported={() => qc.invalidateQueries({ queryKey: serverKeys.all })} />}
        {canEdit && <ServerFormDialog onSaved={() => qc.invalidateQueries({ queryKey: serverKeys.all })} />}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/8 bg-white/3">
              {[
                { key: "id", label: "#" },
                { key: "hostname", label: "Hostname" },
                { key: "ip", label: "IP" },
                { key: "port", label: "Port" },
                { key: "lastStatus", label: "Status" },
                { key: "username", label: "User" },
                { key: "password", label: "Password" },
                { key: "cpu", label: "CPU" },
                { key: "ram", label: "RAM" },
                { key: "disk", label: "Storage" },
                { key: "osType", label: "OS" },
                { key: "gpu", label: "GPU" },
                { key: "project", label: "Project" },
                { key: "network", label: "Network" },
                { key: "location", label: "Location" },
                { key: "tags", label: "Tags" },
                { key: "updatedByEmail", label: "Last Updated By" },
              ].map(col => (
                <th
                  key={col.key}
                  className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer hover:bg-white/5 transition-colors"
                  onClick={() => {
                    if (sortBy === col.key) {
                      setSortDir(sortDir === "asc" ? "desc" : "asc");
                    } else {
                      setSortBy(col.key);
                      setSortDir("asc");
                    }
                    setPage(1);
                  }}
                >
                  <div className="flex items-center gap-1">
                    {col.label}
                    {sortBy === col.key && (
                      <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>
                    )}
                  </div>
                </th>
              ))}
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  {Array.from({ length: 18 }).map((__, j) => (
                    <td key={j} className="px-3 py-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            )}
            {!isLoading && data?.items.length === 0 && (
              <tr>
                <td colSpan={18} className="px-3 py-12 text-center text-muted-foreground text-sm">
                  No servers found
                </td>
              </tr>
            )}
            {data?.items.map((server, idx) => {
              const revealed = revealedPasswords[server.id];
              const isDeleted = !!server.deletedAt;
              return (
                <tr
                  key={server.id}
                  className={`row-animate border-b border-white/5 last:border-0 transition-colors hover:bg-white/4 ${isDeleted ? "opacity-50" : ""}`}
                  style={{ animationDelay: `${idx * 30}ms` }}
                >
                  <td className="px-3 py-2.5 text-muted-foreground text-xs">{server.id}</td>
                  <td className="px-3 py-2.5 font-mono font-medium">
                    {!isDeleted ? (
                      <Link
                        to="/servers/$serverId"
                        params={{ serverId: String(server.id) }}
                        className="text-primary hover:underline cursor-pointer font-semibold"
                      >
                        {server.hostname}
                      </Link>
                    ) : (
                      <span>{server.hostname}</span>
                    )}
                    {server.domain && (
                      <span className="ml-1.5 text-xs text-muted-foreground">{server.domain}</span>
                    )}
                    {server.cloudProvider && (
                      <span className="ml-1 text-xs text-muted-foreground opacity-70">
                        ({server.cloudProvider.name})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{server.ip}</td>
                  <td className="px-3 py-2.5 text-muted-foreground text-xs">{server.sshPort}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <StatusDot
                        status={server.lastStatus as "up" | "down" | "unknown"}
                        latencyMs={server.lastLatencyMs}
                        ip={server.ip}
                        port={server.sshPort}
                        size="sm"
                      />
                      <span className="text-xs capitalize text-muted-foreground">{server.lastStatus}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs">{server.username}</td>
                  <td className="px-3 py-2.5">
                    {server.hasPassword ? (
                      role === "viewer" && !viewerApproved(server.id, "password_reveal") ? (
                        <RequestAccessButton entityId={server.id} entityType="server" type="password_reveal" label="Password" />
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-xs">
                            {revealed !== undefined ? (revealed ?? "—") : "••••••"}
                          </span>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5"
                            onClick={() => handleReveal(server)}
                            title={revealed !== undefined ? "Hide" : "Reveal"}
                          >
                            {revealed !== undefined ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                          </Button>
                        </div>
                      )
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap font-mono">
                    {server.cpu || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap font-mono">
                    {server.ram || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap font-mono">
                    {server.disk || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap truncate max-w-[130px]" title={server.osType || undefined}>
                    {server.osType || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {(!server.gpuCount || server.gpuCount === 0) && !server.gpuType ? "-" :
                      (server.gpuCount && server.gpuCount > 0 && server.gpuType
                        ? `${server.gpuCount}× ${server.gpuType.name}`
                        : (server.gpuType?.name ?? "-"))}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {server.allocatedTo?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {server.networkType?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {server.location?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1 flex-wrap">
                      {server.tags.map((t) => (
                        <Badge
                          key={t.id}
                          variant="outline"
                          className="text-xs px-1.5 py-0"
                          style={t.color ? { backgroundColor: t.color + "22", borderColor: t.color + "55", color: t.color } : {}}
                        >
                          {t.name}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground max-w-35">
                    {server.updatedByEmail ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="truncate block cursor-default" title={server.updatedByEmail}>
                            {server.updatedByEmail.split("@")[0]}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{server.updatedByEmail}</p>
                          <p className="text-muted-foreground text-xs">{new Date(server.updatedAt).toLocaleString()}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      {/* Inline check-now — always visible */}
                      {!isDeleted && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => checkMutation.mutate(server.id)}
                              disabled={checkMutation.isPending}
                            >
                              <Zap className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Check now</TooltipContent>
                        </Tooltip>
                      )}

                      {/* Restore for admin on deleted */}
                      {role === "admin" && isDeleted && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-emerald-500"
                              onClick={() => restoreMutation.mutate(server.id)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Restore</TooltipContent>
                        </Tooltip>
                      )}

                      {/* Copy SSH command (all roles) */}
                      {!isDeleted && (
                        <>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon" variant="ghost"
                                className="h-7 w-7 text-muted-foreground hover:text-primary"
                                onClick={() => {
                                  void navigator.clipboard.writeText(
                                    `ssh -p ${server.sshPort} ${server.username}@${server.ip}`
                                  ).then(() => toast.success("SSH command copied"));
                                }}
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy SSH command</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon" variant="ghost"
                                className="h-7 w-7 text-muted-foreground hover:text-amber-500"
                                onClick={() => {
                                  void navigator.clipboard.writeText(
                                    `ssh -p ${server.sshPort} ${server.username}@${server.ip} -t sudo su -`
                                  ).then(() => toast.success("SSH sudo command copied"));
                                }}
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy SSH + sudo</TooltipContent>
                          </Tooltip>
                        </>
                      )}

                      
                      {/* Dedicated Server Page */}
                      {!isDeleted && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link to="/servers/$serverId" params={{ serverId: String(server.id) }}>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-primary">
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent>Open Dedicated Server Page</TooltipContent>
                        </Tooltip>
                      )}

                      {/* SSH Terminal — admin: direct link; others: request access */}
                      {!isDeleted && role === "admin" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link to="/ssh" search={{ serverId: server.id }}>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-primary">
                                <Terminal className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent>Open SSH Terminal</TooltipContent>
                        </Tooltip>
                      )}
                      {!isDeleted && role !== "admin" && viewerApproved(server.id, "ssh") && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link to="/ssh" search={{ serverId: server.id }}>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-500 hover:text-emerald-400">
                                <Terminal className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent>Open SSH Terminal (approved)</TooltipContent>
                        </Tooltip>
                      )}
                      {!isDeleted && role !== "admin" && !viewerApproved(server.id, "ssh") && (
                        <RequestAccessButton entityId={server.id} entityType="server" type="ssh" label="SSH Terminal" />
                      )}

                      {/* Edit + Delete for editor/admin on active servers */}
                      {canEdit && !isDeleted && (
                        <>
                          <ServerFormDialog
                            server={server}
                            onSaved={() => qc.invalidateQueries({ queryKey: serverKeys.all })}
                          />
                          <DeleteConfirm
                            server={server}
                            onConfirm={() => deleteMutation.mutate(server.id)}
                            isPending={deleteMutation.isPending}
                          />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <PaginationBar
        page={data?.page ?? page}
        totalPages={data?.totalPages ?? 1}
        totalItems={data?.total ?? 0}
        pageSize={pageSize}
        onPageChange={(p) => setPage(p)}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
        disabled={isLoading}
      />

      <ServerDetailModal serverId={detailServerId} onClose={() => setDetailServerId(null)} />
    </div>
  );
}
