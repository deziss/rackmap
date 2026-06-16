import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { ServerDetailModal } from "@/components/server-detail-modal";
import { fetchServers, checkServer, revealPassword, serverKeys } from "@/lib/queries";
import { apiFetch } from "@/lib/api";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  RefreshCw, Eye, EyeOff, Trash2, RotateCcw, Zap,
  Download, AlertTriangle, Terminal, KeyRound, Copy, ShieldCheck,
} from "lucide-react";
import type { ServerDto } from "@inv/shared";
import { useDebounce } from "@/hooks/use-debounce";
import { ServerFormDialog } from "@/components/server-form-dialog";
import { SavedViews } from "@/components/saved-views";
import { ImportWizard } from "@/components/import-wizard";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/servers")({
  component: ServersPage,
});

function RequestAccessButton({ serverId, type, label }: { serverId: number; type: "ssh" | "password_reveal"; label: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch("/api/v1/access-requests", {
        method: "POST",
        body: JSON.stringify({ serverId, type, note: note || undefined }),
      });
      toast.success("Access request submitted — await admin approval");
      setOpen(false);
      setNote("");
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-amber-500 hover:text-amber-400"
            onClick={() => setOpen(true)}
          >
            <KeyRound className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Request {label} access</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Request {label} Access</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-4 mt-2">
            <p className="text-sm text-muted-foreground">Your request will be reviewed by an admin. You'll be notified when approved.</p>
            <div className="space-y-1">
              <Label>Reason (optional)</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Briefly describe why you need access…" className="h-8 text-sm" />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={loading}>{loading ? "Sending…" : "Submit Request"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

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

  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState<number | undefined>();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [detailServerId, setDetailServerId] = useState<number | null>(null);
  const [revealedPasswords, setRevealedPasswords] = useState<Record<number, string | null>>({});
  const debouncedQ = useDebounce(q, 300);

  const params = { q: debouncedQ || undefined, limit: 50, cursor, includeDeleted: includeDeleted || undefined };

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
      <div className="flex items-center gap-2.5 flex-wrap">
        <h1 className="text-xl font-semibold mr-auto tracking-tight">Servers</h1>
        <Input
          placeholder="Search hostname, IP, user…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setCursor(undefined); }}
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
          onLoad={(p) => { setQ(p.q ?? ""); setIncludeDeleted(p.includeDeleted === "true"); setCursor(undefined); }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
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
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-10">#</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Hostname</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">IP</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Port</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">User</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Password</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">GPU</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tags</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Last Updated By</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  {Array.from({ length: 11 }).map((__, j) => (
                    <td key={j} className="px-3 py-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            )}
            {!isLoading && data?.items.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-12 text-center text-muted-foreground text-sm">
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
                      <button
                        type="button"
                        className="text-primary hover:underline cursor-pointer text-left"
                        onClick={() => setDetailServerId(server.id)}
                      >
                        {server.hostname}
                      </button>
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
                        <RequestAccessButton serverId={server.id} type="password_reveal" label="Password" />
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
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {server.gpuCount != null && server.gpuType
                      ? `${server.gpuCount}× ${server.gpuType.name}`
                      : (server.gpuType?.name ?? "—")}
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
                        <RequestAccessButton serverId={server.id} type="ssh" label="SSH Terminal" />
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
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>{data?.total ?? 0} servers total</span>
        <div className="ml-auto flex gap-2">
          {cursor && (
            <Button size="sm" variant="outline" onClick={() => setCursor(undefined)}>First</Button>
          )}
          {data?.nextCursor && (
            <Button size="sm" variant="outline" onClick={() => setCursor(data.nextCursor!)}>Next</Button>
          )}
        </div>
      </div>

      <ServerDetailModal serverId={detailServerId} onClose={() => setDetailServerId(null)} />
    </div>
  );
}
