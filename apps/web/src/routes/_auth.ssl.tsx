import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchSslList, scanAllSsl, scanSslDomain, deleteSslDomain, sslKeys } from "@/lib/queries";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SslFormDialog } from "@/components/ssl-form-dialog";
import { toast } from "sonner";
import { RefreshCw, Trash2, Shield, AlertTriangle } from "lucide-react";
import type { SslStatusDto } from "@inv/shared";

export const Route = createFileRoute("/_auth/ssl")({
  component: SslPage,
});

function SslPage() {
  const qc = useQueryClient();
  const [q] = useState("");
  
  const { data, isLoading } = useQuery({
    queryKey: sslKeys.list({ q }),
    queryFn: () => fetchSslList({ q }),
  });

  const scanAllMutation = useMutation({
    mutationFn: scanAllSsl,
    onSuccess: () => {
      toast.success("SSL scan completed");
      qc.invalidateQueries({ queryKey: sslKeys.all });
    },
    onError: (e: Error) => toast.error(`Scan failed: ${e.message}`)
  });

  const scanSingleMutation = useMutation({
    mutationFn: scanSslDomain,
    onSuccess: () => {
      toast.success("Domain scanned successfully");
      qc.invalidateQueries({ queryKey: sslKeys.all });
    },
    onError: (e: Error) => toast.error(`Scan failed: ${e.message}`)
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSslDomain,
    onSuccess: () => {
      toast.success("Domain removed");
      qc.invalidateQueries({ queryKey: sslKeys.all });
    },
    onError: (e: Error) => toast.error(`Delete failed: ${e.message}`)
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-4 bg-card/40 backdrop-blur-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" /> SSL Status
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor SSL certificates across all domains.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {scanAllMutation.isPending ? (
            <Button size="sm" variant="outline" disabled className="gap-2 text-muted-foreground border-amber-500/50 bg-amber-500/10">
              <RefreshCw className="h-4 w-4 animate-spin text-amber-500" />
              Scanning All...
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="gap-2" onClick={() => scanAllMutation.mutate()}>
              <RefreshCw className="h-4 w-4" /> Scan All Domains
            </Button>
          )}
          <SshSeparator />
          <SslFormDialog onSaved={() => qc.invalidateQueries({ queryKey: sslKeys.all })} />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {/* Table */}
        <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/3">
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Domain</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Valid To</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Days Left</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Issuer</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Team / Project</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Linked To</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-white/5">
                    {Array.from({ length: 8 }).map((__, j) => (
                      <td key={j} className="px-3 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              )}
              {!isLoading && data?.items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-muted-foreground text-sm">
                    No domains tracked yet. Click "Scan All Domains" to auto-discover.
                  </td>
                </tr>
              )}
              {data?.items.map((ssl: SslStatusDto) => (
                <tr key={ssl.id} className="border-b border-white/5 last:border-0 hover:bg-white/4">
                  <td className="px-3 py-3 font-mono font-medium">
                    {ssl.domain}
                    {ssl.isManual && <span className="ml-2 text-[10px] text-muted-foreground">(Manual)</span>}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={ssl.status} error={ssl.lastError} />
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {ssl.validTo ? new Date(ssl.validTo).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {ssl.daysRemaining != null ? (
                      <span className={ssl.daysRemaining <= 30 ? "text-amber-500 font-bold" : ssl.daysRemaining <= 0 ? "text-destructive font-bold" : ""}>
                        {ssl.daysRemaining} days
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground truncate max-w-[150px]" title={ssl.issuer ?? ""}>
                    {ssl.issuer ?? "—"}
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">
                    {ssl.team ? <Badge variant="outline" className="mr-1 text-[10px]">{ssl.team}</Badge> : null}
                    {ssl.project ?? "—"}
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">
                    {ssl.server ? `Server: ${ssl.server.name}` : ssl.service ? `Service: ${ssl.service.name}` : "—"}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => scanSingleMutation.mutate(ssl.id)} disabled={scanSingleMutation.isPending}>
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                      <SslFormDialog ssl={ssl} onSaved={() => qc.invalidateQueries({ queryKey: sslKeys.all })} />
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => { if(confirm("Remove domain?")) deleteMutation.mutate(ssl.id); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, error }: { status: string; error: string | null }) {
  if (status === "valid") return <Badge variant="default" className="bg-emerald-500/20 text-emerald-500 hover:bg-emerald-500/30">Valid</Badge>;
  if (status === "expiring_soon") return <Badge variant="default" className="bg-amber-500/20 text-amber-500 hover:bg-amber-500/30">Expiring</Badge>;
  if (status === "expired") return <Badge variant="destructive">Expired</Badge>;
  if (status === "error") return (
    <Badge variant="outline" className="text-destructive border-destructive/50" title={error ?? ""}>
      <AlertTriangle className="h-3 w-3 mr-1" /> Error
    </Badge>
  );
  return <Badge variant="secondary">Unknown</Badge>;
}

function SshSeparator() {
  return <div className="h-6 w-px bg-white/10" />;
}
