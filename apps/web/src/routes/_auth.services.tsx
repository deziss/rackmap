import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { fetchServices, checkService, checkAllServices, revealServicePassword, deleteService, serviceKeys } from "@/lib/queries";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  RefreshCw, Eye, EyeOff, Trash2, Zap,
  Copy, Download
} from "lucide-react";
import type { ServiceDto } from "@inv/shared";
import { useDebounce } from "@/hooks/use-debounce";
import { ServiceDetailModal } from "@/components/service-detail-modal";
import { ServiceFormDialog } from "@/components/service-form-dialog";
import { ServiceImportWizard } from "@/components/service-import-wizard";
import { RequestAccessButton } from "@/components/request-access-button";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/services")({
  component: ServicesPage,
});

function DeleteConfirm({ service, onConfirm, isPending }: { service: ServiceDto; onConfirm: () => void; isPending: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive hover:text-destructive/90"
            onClick={() => setOpen(true)}
            disabled={isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete service</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This will soft-delete the service <span className="font-mono text-foreground">{service.serviceName}</span>. It can be restored by an administrator.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={(e) => { e.preventDefault(); onConfirm(); setOpen(false); }} disabled={isPending} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PasswordCell({ serviceId, hasPassword, canReveal, isViewer, isApproved }: { serviceId: number; hasPassword: boolean; canReveal: boolean; isViewer: boolean; isApproved: boolean }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!hasPassword) return <span className="text-muted-foreground/50 text-xs italic">—</span>;

  const toggle = async () => {
    if (revealed) {
      setRevealed(null);
      return;
    }
    setLoading(true);
    try {
      const res = await revealServicePassword(serviceId);
      setRevealed(res.password);
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!revealed) return;
    await navigator.clipboard.writeText(revealed);
    toast.success("Password copied to clipboard");
  };

  const canShowReveal = canReveal || (isViewer && isApproved);

  return (
    <div className="flex items-center gap-1 min-w-[80px]">
      <span className="font-mono text-xs min-w-[60px] max-w-[150px] truncate block tracking-wider" title={revealed ?? "Hidden password"}>
        {revealed ? revealed : "••••••••"}
      </span>
      {canShowReveal ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0" onClick={toggle} disabled={loading}>
              {loading ? <RefreshCw className="h-3 w-3 animate-spin" /> : revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{revealed ? "Hide" : "Reveal"} password</TooltipContent>
        </Tooltip>
      ) : isViewer ? (
        <RequestAccessButton entityId={serviceId} entityType="service" type="service_password_reveal" label="Password" />
      ) : null}
      {revealed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0" onClick={copy}>
              <Copy className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy password</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function ServicesPage() {
  const { data: sessionData } = authClient.useSession();
  const userRole = sessionData?.user?.role;
  const isAdmin = userRole === "admin";
  const isEditor = userRole === "editor";
  const isViewer = userRole === "viewer";
  const canModify = isAdmin || isEditor;
  const canReveal = isAdmin || isEditor;

  const [detailServiceId, setDetailServiceId] = useState<number | null>(null);

  const queryClient = useQueryClient();

  // Viewer: fetch own access requests to derive per-service approval without N+1 calls
  const { data: myRequests } = useQuery({
    queryKey: ["access-requests", "mine"],
    queryFn: () => apiFetch<{ serviceId: number; type: string; status: string; expiresAt: string | null }[]>("/api/v1/access-requests"),
    enabled: isViewer,
    refetchInterval: 15_000,
  });

  function viewerApproved(serviceId: number, type: "service_password_reveal"): boolean {
    if (!isViewer || !myRequests) return false;
    const now = Date.now();
    return myRequests.some(
      (r) =>
        r.serviceId === serviceId &&
        r.type === type &&
        r.status === "approved" &&
        (r.expiresAt === null || new Date(r.expiresAt).getTime() > now),
    );
  }

  // Search & Pagination State
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [limit] = useState(50);
  
  const [cursorHistory, setCursorHistory] = useState<number[]>([]);
  const currentCursor = cursorHistory.length > 0 ? cursorHistory[cursorHistory.length - 1] : undefined;

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: serviceKeys.list({ q: debouncedSearch, cursor: currentCursor, limit }),
    queryFn: () => fetchServices({ q: debouncedSearch, cursor: currentCursor, limit }),
    placeholderData: (prev) => prev,
  });

  const goNext = useCallback(() => {
    if (data?.nextCursor) {
      setCursorHistory((prev) => [...prev, data.nextCursor!]);
    }
  }, [data?.nextCursor]);

  const goPrev = useCallback(() => {
    setCursorHistory((prev) => prev.slice(0, -1));
  }, []);

  const resetPagination = useCallback(() => {
    setCursorHistory([]);
  }, []);

  // Reset pagination on search change
  useState(() => { resetPagination(); });

  async function triggerDownload(format: "xlsx" | "json", searchQ: string) {
    const url = `/api/v1/services/export.${format}?q=${encodeURIComponent(searchQ)}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) { toast.error("Export failed"); return; }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `services-${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch {
      toast.error("Export failed");
    }
  }

  const deleteMut = useMutation({
    mutationFn: deleteService,
    onSuccess: () => {
      toast.success("Service deleted");
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const checkMut = useMutation({
    mutationFn: checkService,
    onSuccess: (res: any) => {
      toast.success(res.status === "up" ? `Service is UP (${res.latencyMs}ms)` : `Service is DOWN: ${res.errorCode}`);
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
    },
    onError: (err: Error) => toast.error(`Health check failed: ${err.message}`),
  });

  const checkAllMut = useMutation({
    mutationFn: checkAllServices,
    onSuccess: (res) => {
      toast.success(`Checked ${res.checked} services`);
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
    },
    onError: (err: Error) => toast.error(`Bulk health check failed: ${err.message}`),
  });

  return (
    <div className="space-y-4">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-1">
        <h1 className="text-2xl font-semibold tracking-tight">Services Inventory</h1>
        <div className="flex items-center gap-2">
          {canModify && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => checkAllMut.mutate()}
              disabled={checkAllMut.isPending}
            >
              <RefreshCw className={`h-4 w-4 ${checkAllMut.isPending ? "animate-spin" : ""}`} />
              Check All Health
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => triggerDownload("xlsx", debouncedSearch)}
          >
            <Download className="h-3.5 w-3.5" /> XLSX
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => triggerDownload("json", debouncedSearch)}
          >
            <Download className="h-3.5 w-3.5" /> JSON
          </Button>
          {canModify && <ServiceImportWizard onImported={() => queryClient.invalidateQueries({ queryKey: serviceKeys.all })} />}
          {canModify && <ServiceFormDialog onSaved={() => queryClient.invalidateQueries({ queryKey: serviceKeys.all })} />}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 p-1">
        <div className="relative max-w-sm w-full flex-1">
          <Input
            placeholder="Search services, IPs, domains..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
          <svg className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {/* Main Table */}
      <div className="border rounded-lg bg-card text-card-foreground shadow-sm overflow-x-auto relative">
        <div className="min-w-[1600px]">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/50 border-b">
              <tr className="whitespace-nowrap">
                <th className="px-3 py-2.5 font-medium w-6">Status</th>
                <th className="px-3 py-2.5 font-medium">Service Name</th>
                <th className="px-3 py-2.5 font-medium">Project</th>
                <th className="px-3 py-2.5 font-medium">Type</th>
                <th className="px-3 py-2.5 font-medium">Endpoint</th>
                <th className="px-3 py-2.5 font-medium">Auth</th>
                <th className="px-3 py-2.5 font-medium">Environment</th>
                <th className="px-3 py-2.5 font-medium">DB Name</th>
                <th className="px-3 py-2.5 font-medium">Managed By</th>
                <th className="px-3 py-2.5 font-medium">Docs / Health</th>
                <th className="px-3 py-2.5 font-medium max-w-[200px]">Remark</th>
                <th className="px-3 py-2.5 font-medium text-right sticky right-0 bg-muted/50 z-10">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-3 py-3"><Skeleton className="h-3 w-3 rounded-full" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-40" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-3 py-3 text-right"><Skeleton className="h-6 w-20 ml-auto" /></td>
                  </tr>
                ))
              ) : isError ? (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-destructive">
                    Error: {(error as Error).message}
                  </td>
                </tr>
              ) : data?.items.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-muted-foreground">
                    No services found matching the criteria.
                  </td>
                </tr>
              ) : (
                data?.items.map((svc: ServiceDto) => (
                  <tr key={svc.id} className="hover:bg-muted/30 transition-colors group">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center justify-center w-6 cursor-help">
                            <StatusDot status={svc.lastStatus} />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          {svc.lastStatus.toUpperCase()} 
                          {svc.lastLatencyMs !== null && ` (${svc.lastLatencyMs}ms)`}
                          {svc.lastCheckedAt && `\nChecked: ${new Date(svc.lastCheckedAt).toLocaleString()}`}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">
                      <button
                        type="button"
                        className="text-primary hover:underline cursor-pointer text-left"
                        onClick={() => setDetailServiceId(svc.id)}
                      >
                        {svc.serviceName}
                      </button>
                      {svc.version && <span className="ml-2 text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">v{svc.version}</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {svc.project || "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {svc.serviceType || "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex flex-col">
                        <span className="font-mono text-xs">{svc.serverIp || "—"}{svc.port ? `:${svc.port}` : ""}</span>
                        {svc.domain && <span className="text-xs text-muted-foreground">{svc.domain}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex flex-col text-xs gap-1">
                        <span className="font-mono text-muted-foreground">{svc.username || "—"}</span>
                        <PasswordCell
                          serviceId={svc.id}
                          hasPassword={svc.hasPassword}
                          canReveal={canReveal}
                          isViewer={isViewer}
                          isApproved={viewerApproved(svc.id, "service_password_reveal")}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {svc.environment ? (
                        <span className="text-xs px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded border">
                          {svc.environment}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {svc.dbName || "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {svc.managedBy || "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex gap-2 text-xs">
                        {svc.documentLink ? <a href={svc.documentLink} target="_blank" rel="noreferrer" className="text-primary hover:underline">Docs</a> : <span className="text-muted-foreground/50">—</span>}
                        {svc.healthUrl ? <a href={svc.healthUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Health</a> : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-[200px] truncate" title={svc.remark || ""}>
                      {svc.remark || "—"}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap sticky right-0 bg-card group-hover:bg-muted/30 transition-colors z-10 border-l">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-amber-500 hover:text-amber-400"
                              onClick={() => checkMut.mutate(svc.id)}
                              disabled={checkMut.isPending}
                            >
                              <Zap className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Run health check</TooltipContent>
                        </Tooltip>

                        {canModify && (
                          <>
                            <ServiceFormDialog
                              service={svc}
                              onSaved={() => queryClient.invalidateQueries({ queryKey: serviceKeys.all })}
                            />
                            <DeleteConfirm
                              service={svc}
                              onConfirm={() => deleteMut.mutate(svc.id)}
                              isPending={deleteMut.isPending}
                            />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {/* Loading overlay for pagination/search while data exists */}
        {isFetching && !isLoading && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Pagination Controls */}
      {data && (
        <div className="flex items-center justify-between text-sm p-1">
          <div className="text-muted-foreground">
            {cursorHistory.length === 0 ? "Page 1" : `Page ${cursorHistory.length + 1}`}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={goPrev}
              disabled={cursorHistory.length === 0 || isFetching}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={goNext}
              disabled={!data.nextCursor || isFetching}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <ServiceDetailModal serviceId={detailServiceId} onClose={() => setDetailServiceId(null)} />
    </div>
  );
}
