import { PaginationBar } from "@/components/pagination-bar";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchSslList, scanAllSsl, scanSslDomain, deleteSslDomain, sslKeys } from "@/lib/queries";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SslFormDialog } from "@/components/ssl-form-dialog";
import { toast } from "sonner";
import { RefreshCw, Trash2, Shield, AlertTriangle, RotateCcw, Search, Globe } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useDebounce } from "@/hooks/use-debounce";
import type { SslStatusDto } from "@inv/shared";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/ssl")({
  component: SslPage,
});

function SslPage() {
  const qc = useQueryClient();
  const { data: session } = authClient.useSession();
  const role = (session?.user as { role?: string })?.role ?? "viewer";
  const isAdmin = role === "admin";

  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [includeWildcardSubdomains, setIncludeWildcardSubdomains] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [sortBy, setSortBy] = useState<string>("id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data, isLoading } = useQuery({
    queryKey: sslKeys.list({ page, limit, sortBy, sortDir, includeDeleted, includeWildcardSubdomains, q: debouncedSearch }),
    queryFn: () => fetchSslList({ page, limit, sortBy, sortDir, includeDeleted, includeWildcardSubdomains, q: debouncedSearch }),
  });

  const handleSort = (key: string) => {
    if (sortBy === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortBy(key);
      setSortDir("asc");
    }
    setPage(1);
  };

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

  const restoreMutation = useMutation({
    mutationFn: (id: number) => fetch(`/api/v1/ssl/${id}/restore`, { method: "POST", credentials: "include" }).then(r => r.json()),
    onSuccess: () => {
      toast.success("Domain restored");
      qc.invalidateQueries({ queryKey: sslKeys.all });
    },
    onError: (e: Error) => toast.error(`Restore failed: ${e.message}`)
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-4 bg-card/40 backdrop-blur-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" /> SSL Status
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor SSL certificates across all domains.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search domains, teams..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="h-8 pl-8 pr-2 text-xs bg-zinc-900/60 border-zinc-700 font-mono"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeWildcardSubdomains}
              onChange={(e) => {
                setIncludeWildcardSubdomains(e.target.checked);
                setPage(1);
              }}
              className="accent-primary"
            />
            Show wildcard subdomains
          </label>
          {isAdmin && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeDeleted}
                onChange={(e) => {
                  setIncludeDeleted(e.target.checked);
                  setPage(1);
                }}
                className="accent-primary"
              />
              Show deleted
            </label>
          )}
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
        {Boolean(data?.omittedSubdomainsCount && data.omittedSubdomainsCount > 0 && !includeWildcardSubdomains) && (
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-primary/10 border border-primary/20 text-xs text-primary font-medium">
            <Globe className="h-4 w-4 shrink-0" />
            <span>
              <strong>{data.omittedSubdomainsCount} related subdomains omitted</strong> because parent wildcard domain{data.activeWildcards?.length > 1 ? "s are" : " is"} tracked ({data.activeWildcards?.join(", ")}).
            </span>
            <button
              onClick={() => setIncludeWildcardSubdomains(true)}
              className="underline hover:text-foreground font-semibold cursor-pointer ml-auto shrink-0"
            >
              Show all subdomains
            </button>
          </div>
        )}

        {/* Table */}
        <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/3">
                {[
                  { key: "domain", label: "Domain" },
                  { key: "status", label: "Status" },
                  { key: "validTo", label: "Valid To" },
                  { key: "daysRemaining", label: "Days Left" },
                  { key: "issuer", label: "Issuer" },
                  { key: "project", label: "Team / Project" },
                  { key: "serverId", label: "Linked To" },
                ].map(col => (
                  <th
                    key={col.key}
                    className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer hover:bg-white/5 transition-colors"
                    onClick={() => handleSort(col.key)}
                  >
                    <div className="flex items-center gap-1">
                      {col.label}
                      {sortBy === col.key && (
                        <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>
                      )}
                    </div>
                  </th>
                ))}
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
              {data?.items.map((ssl: SslStatusDto) => {
                const isDeleted = !!(ssl as any).deletedAt;
                return (
                <tr key={ssl.id} className={`border-b border-white/5 last:border-0 hover:bg-white/4 ${isDeleted ? "opacity-50" : ""}`}>
                  <td className="px-3 py-3 font-mono font-medium">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span>{ssl.domain}</span>
                      {ssl.domain.startsWith("*.") && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-primary/15 text-primary border-primary/30 font-sans font-semibold">
                          Wildcard
                        </Badge>
                      )}
                      {ssl.isManual && <span className="text-[10px] text-muted-foreground font-sans">(Manual)</span>}
                    </div>
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
                      {isDeleted ? (
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/20 transition-colors" onClick={() => { if(confirm("Restore domain?")) restoreMutation.mutate(ssl.id); }}>
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-amber-400 hover:bg-amber-500/20 transition-colors" onClick={() => scanSingleMutation.mutate(ssl.id)} disabled={scanSingleMutation.isPending} title="Scan SSL Certificate">
                            <RefreshCw className={`h-3.5 w-3.5 ${scanSingleMutation.isPending ? "animate-spin" : ""}`} />
                          </Button>
                          <SslFormDialog ssl={ssl} onSaved={() => qc.invalidateQueries({ queryKey: sslKeys.all })} />
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-rose-400 hover:bg-rose-500/20 transition-colors" onClick={() => { if(confirm("Remove domain?")) deleteMutation.mutate(ssl.id); }} title="Remove domain">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
        {data && (
          <PaginationBar
            page={page}
            totalPages={data.totalPages ?? Math.ceil(data.total / limit) ?? 1}
            totalItems={data.total}
            pageSize={limit}
            onPageChange={(p: number) => setPage(p)}
            onPageSizeChange={(s: number) => {
              setLimit(s);
              setPage(1);
            }}
            pageSizeOptions={[10, 25, 50, 100]}
            className="mt-4 border-t pt-2"
          />
        )}
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
