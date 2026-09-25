import { useState, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2, PackageCheck, RefreshCw, RotateCcw, Search, ShieldAlert, XCircle } from "lucide-react";
import type { PatchFleetRow } from "@inv/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PaginationBar } from "@/components/pagination-bar";
import { ApplyPatchesDialog } from "@/components/patches/apply-patches-dialog";
import { PatchStateBadge, RebootBadge, kernelTitle, relativeTime, usePatchPermissions } from "@/components/patches/patch-bits";
import { useDebounce } from "@/hooks/use-debounce";
import {
  fetchPatchList,
  fetchPatchSummary,
  patchKeys,
  scanFleetPatches,
  scanServerPatches,
  type PatchListParams,
} from "@/lib/patches-api";

export const Route = createFileRoute("/_auth/patches")({
  component: PatchesPage,
});

type StatusFilter = NonNullable<PatchListParams["status"]> | "all";

const COLUMNS: { key: string; label: string; align?: "right" }[] = [
  { key: "hostname", label: "Server" },
  { key: "packageManager", label: "OS / manager" },
  { key: "upgradableCount", label: "Updates", align: "right" },
  { key: "securityCount", label: "Security", align: "right" },
  { key: "rebootRequired", label: "Reboot" },
  { key: "status", label: "Status" },
  { key: "scannedAt", label: "Scanned" },
];

function PatchesPage() {
  const qc = useQueryClient();
  const perms = usePatchPermissions();
  const [search, setSearch] = useState("");
  const q = useDebounce(search, 300);
  const [securityOnly, setSecurityOnly] = useState(false);
  const [rebootOnly, setRebootOnly] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [scanning, setScanning] = useState<Set<number>>(new Set());
  const [applyRow, setApplyRow] = useState<PatchFleetRow | null>(null);

  const summary = useQuery({
    queryKey: patchKeys.summary,
    queryFn: fetchPatchSummary,
    // Poll while this API instance still has scans queued or running.
    refetchInterval: (query) => ((query.state.data?.scanning ?? 0) > 0 ? 3_000 : 60_000),
  });
  const busy = (summary.data?.scanning ?? 0) > 0;

  const params: PatchListParams = {
    page,
    limit,
    sortBy,
    sortDir: sortBy ? sortDir : undefined,
    q: q || undefined,
    securityOnly,
    rebootRequired: rebootOnly,
    status: status === "all" ? undefined : status,
  };
  const list = useQuery({
    queryKey: patchKeys.list(params),
    queryFn: () => fetchPatchList(params),
    refetchInterval: busy ? 3_000 : 60_000,
  });
  const items = list.data?.items ?? [];

  const scanAll = useMutation({
    mutationFn: () => scanFleetPatches(),
    onSuccess: (res) => {
      toast.success(res.queued > 0 ? `Queued ${res.queued} scan${res.queued === 1 ? "" : "s"}` : "Every server is already being scanned");
      qc.invalidateQueries({ queryKey: patchKeys.all });
    },
    onError: (e: Error) => toast.error(`Could not start the scan: ${e.message}`),
  });

  const scanOne = useMutation({
    mutationFn: (serverId: number) => scanServerPatches(serverId),
    onMutate: (serverId) => setScanning((s) => new Set(s).add(serverId)),
    onSuccess: (res, serverId) => {
      const row = items.find((i) => i.serverId === serverId);
      if (res.status === "ok") toast.success(`${row?.hostname ?? "Server"}: ${res.upgradableCount} update${res.upgradableCount === 1 ? "" : "s"} pending`);
      else toast.error(`${row?.hostname ?? "Server"}: ${res.error ?? "scan failed"}`);
    },
    onError: (e: Error) => toast.error(`Scan failed: ${e.message}`),
    onSettled: (_res, _err, serverId) => {
      setScanning((s) => {
        const next = new Set(s);
        next.delete(serverId);
        return next;
      });
      qc.invalidateQueries({ queryKey: patchKeys.all });
      qc.invalidateQueries({ queryKey: patchKeys.server(serverId) });
    },
  });

  const handleSort = (key: string) => {
    if (sortBy === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortBy(key);
      setSortDir(["hostname", "packageManager", "status"].includes(key) ? "asc" : "desc");
    }
    setPage(1);
  };

  const s = summary.data;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-4 bg-card/40 backdrop-blur-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-primary" /> Patches
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pending package updates, security updates and reboots across the fleet.
            {s?.lastScannedAt && <> Last scan {relativeTime(s.lastScannedAt)}.</>}
          </p>
        </div>
        {perms.canPatch && (
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            disabled={scanAll.isPending || busy}
            onClick={() => scanAll.mutate()}
          >
            <RefreshCw className={`h-4 w-4 ${busy || scanAll.isPending ? "animate-spin" : ""}`} />
            {busy ? `Scanning (${s?.scanning})…` : "Scan all"}
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile
            icon={<ShieldAlert className="h-4 w-4 text-destructive" />}
            label="Servers with security updates"
            value={s ? s.withSecurityUpdates : null}
            sub={s ? `of ${s.totalServers} servers · ${s.totalSecurityUpdates} updates` : undefined}
            active={securityOnly}
            onClick={() => {
              setSecurityOnly((v) => !v);
              setPage(1);
            }}
          />
          <Tile
            icon={<PackageCheck className="h-4 w-4 text-amber-400" />}
            label="Pending updates"
            value={s ? s.totalUpdates : null}
            sub={s ? `on ${s.withUpdates} server${s.withUpdates === 1 ? "" : "s"}` : undefined}
          />
          <Tile
            icon={<RotateCcw className="h-4 w-4 text-amber-400" />}
            label="Reboot required"
            value={s ? s.rebootRequired : null}
            sub="Never rebooted by RackMap"
            active={rebootOnly}
            onClick={() => {
              setRebootOnly((v) => !v);
              setPage(1);
            }}
          />
          <Tile
            icon={<XCircle className="h-4 w-4 text-destructive" />}
            label="Scan errors"
            value={s ? s.errors : null}
            sub={s ? `${s.unsupported} unsupported · ${s.neverScanned} never scanned` : undefined}
            active={status === "error"}
            onClick={() => {
              setStatus((v) => (v === "error" ? "all" : "error"));
              setPage(1);
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-72">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search hostname, IP, OS, location…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="h-8 pl-8 pr-2 text-xs bg-zinc-900/60 border-zinc-700"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-primary"
              checked={securityOnly}
              onChange={(e) => {
                setSecurityOnly(e.target.checked);
                setPage(1);
              }}
            />
            Security updates only
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-primary"
              checked={rebootOnly}
              onChange={(e) => {
                setRebootOnly(e.target.checked);
                setPage(1);
              }}
            />
            Reboot required
          </label>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v as StatusFilter);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="ok">Scanned OK</SelectItem>
              <SelectItem value="error">Scan failed</SelectItem>
              <SelectItem value="unsupported">Unsupported</SelectItem>
              <SelectItem value="never">Never scanned</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/3">
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={`px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer hover:bg-white/5 transition-colors ${
                      col.align === "right" ? "text-right" : "text-left"
                    }`}
                    onClick={() => handleSort(col.key)}
                  >
                    <div className={`flex items-center gap-1 ${col.align === "right" ? "justify-end" : ""}`}>
                      {col.label}
                      {sortBy === col.key && <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </div>
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading &&
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-white/5">
                    {Array.from({ length: COLUMNS.length + 1 }).map((__, j) => (
                      <td key={j} className="px-3 py-3">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!list.isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="px-3 py-12 text-center text-muted-foreground text-sm">
                    {list.isError ? (list.error as Error).message : "No servers match these filters."}
                  </td>
                </tr>
              )}
              {items.map((row) => {
                const p = row.patch;
                const rowScanning = scanning.has(row.serverId);
                return (
                  <tr key={row.serverId} className="border-b border-white/5 last:border-0 hover:bg-white/4 align-top">
                    <td className="px-3 py-2.5">
                      <Link
                        to="/servers/$serverId"
                        params={{ serverId: String(row.serverId) }}
                        className="font-mono font-medium hover:underline"
                      >
                        {row.hostname}
                      </Link>
                      <div className="text-[11px] text-muted-foreground">
                        {row.ip}
                        {row.environment ? ` · ${row.environment}` : ""}
                        {row.location ? ` · ${row.location.name}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <div className="truncate max-w-[220px]" title={p?.osPretty ?? undefined}>
                        {p?.osPretty ?? "—"}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {p?.packageManager ?? "—"}
                        {p?.kernelRunning && (
                          <span className="font-mono" title={kernelTitle(p)}>
                            {" "}
                            · {p.kernelRunning}
                            {p.kernelUpdatePending && <span className="text-amber-400"> (newer installed)</span>}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{p ? p.upgradableCount : "—"}</td>
                    <td className={`px-3 py-2.5 text-right font-mono ${p && p.securityCount > 0 ? "text-destructive font-semibold" : ""}`}>
                      {p ? p.securityCount : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      {p?.rebootRequired ? <RebootBadge patch={p} /> : <span className="text-xs text-muted-foreground">{p ? "No" : "—"}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <PatchStateBadge patch={p} />
                      {p?.error && (
                        <div
                          className={`mt-1 flex items-start gap-1 text-[11px] max-w-[260px] ${p.status === "ok" ? "text-amber-400" : "text-destructive"}`}
                          title={p.error}
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
                          <span className="line-clamp-2">{p.error}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap" title={p?.scannedAt}>
                      {relativeTime(p?.scannedAt)}
                      {p?.lastAppliedAt && <div className="text-[11px]">applied {relativeTime(p.lastAppliedAt)}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {perms.canPatch && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1"
                            disabled={rowScanning}
                            onClick={() => scanOne.mutate(row.serverId)}
                          >
                            {rowScanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            Scan
                          </Button>
                        )}
                        {perms.canApply && p?.status === "ok" && p.upgradableCount > 0 && (
                          <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setApplyRow(row)}>
                            <PackageCheck className="h-3.5 w-3.5" /> Apply
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {list.data && list.data.total > 0 && (
          <PaginationBar
            page={page}
            totalPages={list.data.totalPages}
            totalItems={list.data.total}
            pageSize={limit}
            onPageChange={(n: number) => setPage(n)}
            onPageSizeChange={(n: number) => {
              setLimit(n);
              setPage(1);
            }}
            pageSizeOptions={[25, 50, 100, 250]}
          />
        )}
      </div>

      {applyRow?.patch && (
        <ApplyPatchesDialog
          open={!!applyRow}
          onOpenChange={(o) => !o && setApplyRow(null)}
          serverId={applyRow.serverId}
          hostname={applyRow.hostname}
          packageManager={applyRow.patch.packageManager}
          securityCount={applyRow.patch.securityCount}
          upgradableCount={applyRow.patch.upgradableCount}
        />
      )}
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  sub,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: number | null;
  sub?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={`text-left rounded-xl border bg-card/60 backdrop-blur-md p-4 transition-colors ${
        active ? "border-primary/50 ring-1 ring-primary/30" : "border-white/10"
      } ${onClick ? "hover:bg-white/5 cursor-pointer" : ""}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value === null ? <Skeleton className="h-7 w-12" /> : value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </Comp>
  );
}
