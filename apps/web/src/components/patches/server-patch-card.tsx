import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Loader2, PackageCheck, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { fetchServerPatches, patchKeys, scanServerPatches } from "@/lib/patches-api";
import { fetchServer, serverKeys } from "@/lib/queries";
import { ApplyPatchesDialog } from "./apply-patches-dialog";
import { PatchStateBadge, RebootBadge, relativeTime, usePatchPermissions } from "./patch-bits";

const COLLAPSED_ROWS = 8;

/** Pending updates, security updates and reboot state of one server, for the server detail page. */
export function ServerPatchCard({ serverId }: { serverId: number }) {
  const qc = useQueryClient();
  const perms = usePatchPermissions();
  const [expanded, setExpanded] = useState(false);
  const [applying, setApplying] = useState(false);
  const { data: patch, isLoading, error } = useQuery({
    queryKey: patchKeys.server(serverId),
    queryFn: () => fetchServerPatches(serverId),
  });

  const scan = useMutation({
    mutationFn: () => scanServerPatches(serverId),
    onSuccess: (res) => {
      qc.setQueryData(patchKeys.server(serverId), res);
      if (res.status === "ok") toast.success(`Scan finished: ${res.upgradableCount} update${res.upgradableCount === 1 ? "" : "s"} pending`);
      else toast.error(res.error ?? "Scan failed");
    },
    onError: (err: Error) => toast.error(`Scan failed: ${err.message}`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: patchKeys.server(serverId) });
      qc.invalidateQueries({ queryKey: patchKeys.all });
    },
  });

  // Shares the server page's cache entry; only used for the dialog's wording.
  const { data: server } = useQuery({ queryKey: serverKeys.detail(serverId), queryFn: () => fetchServer(serverId) });

  const packages = patch?.packages ?? [];
  const shown = expanded ? packages : packages.slice(0, COLLAPSED_ROWS);
  const hostname = server?.hostname ?? `server #${serverId}`;

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0 gap-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <PackageCheck className="h-4 w-4 text-emerald-500" />
          Patches
          <PatchStateBadge patch={patch ?? null} />
          <RebootBadge patch={patch ?? null} />
        </CardTitle>
        <div className="flex items-center gap-1.5">
          {perms.canPatch && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" disabled={scan.isPending} onClick={() => scan.mutate()}>
              {scan.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {scan.isPending ? "Scanning…" : "Scan"}
            </Button>
          )}
          {perms.canApply && patch && patch.status === "ok" && patch.upgradableCount > 0 && (
            <Button size="sm" className="h-7 text-xs gap-1.5" onClick={() => setApplying(true)}>
              <PackageCheck className="h-3.5 w-3.5" /> Apply…
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading patch status…
          </div>
        ) : error ? (
          <p className="text-xs text-destructive">{(error as Error).message}</p>
        ) : !patch ? (
          <p className="text-xs text-muted-foreground">
            Not scanned yet. {perms.canPatch ? "Press Scan to list pending updates." : "The nightly fleet scan will pick it up."}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <Stat label="Updates" value={patch.upgradableCount} />
              <Stat label="Security" value={patch.securityCount} tone={patch.securityCount > 0 ? "danger" : undefined} />
              <Stat label="Package manager" value={patch.packageManager ?? "—"} />
              <Stat label="Last scan" value={relativeTime(patch.scannedAt)} />
            </div>
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              {patch.osPretty && <div>{patch.osPretty}</div>}
              {patch.kernelRunning && (
                <div>
                  Kernel <span className="font-mono">{patch.kernelRunning}</span>
                  {patch.kernelUpdatePending && patch.kernelLatest && (
                    <>
                      {" "}
                      → <span className="font-mono text-amber-400">{patch.kernelLatest}</span> installed, active after a reboot
                    </>
                  )}
                </div>
              )}
              {patch.lastAppliedAt && <div>Updates last applied {relativeTime(patch.lastAppliedAt)}</div>}
            </div>
            {patch.error && (
              <div
                className={`flex items-start gap-2 rounded-md border p-2 text-[11px] ${
                  patch.status === "ok" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-destructive/30 bg-destructive/10 text-destructive"
                }`}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>
                  {patch.status === "error" ? "Last scan failed: " : ""}
                  {patch.error}
                </span>
              </div>
            )}
            {packages.length > 0 && (
              <div className="rounded-md border border-white/10 overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="bg-white/3 text-muted-foreground">
                      <th className="px-2 py-1.5 text-left font-semibold">Package</th>
                      <th className="px-2 py-1.5 text-left font-semibold">Installed</th>
                      <th className="px-2 py-1.5 text-left font-semibold">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={`${p.name}-${p.available}`} className="border-t border-white/5">
                        <td className="px-2 py-1 font-mono">
                          <span className="inline-flex items-center gap-1">
                            {p.security && <ShieldAlert className="h-3 w-3 text-destructive" aria-label="Security update" />}
                            {p.name}
                          </span>
                        </td>
                        <td className="px-2 py-1 font-mono text-muted-foreground">{p.current ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">{p.available}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(packages.length > COLLAPSED_ROWS || patch.packagesTruncated) && (
                  <div className="flex items-center justify-between border-t border-white/5 px-2 py-1.5 text-[11px] text-muted-foreground">
                    <span>
                      {patch.packagesTruncated
                        ? `Listing ${packages.length} of ${patch.upgradableCount} updates`
                        : `${packages.length} updates`}
                    </span>
                    {packages.length > COLLAPSED_ROWS && (
                      <button className="underline hover:text-foreground" onClick={() => setExpanded((e) => !e)}>
                        {expanded ? "Show fewer" : "Show all"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {patch.packageManager === "zypper" && patch.securityCount > 0 && (
              <p className="text-[11px] text-muted-foreground">
                <Badge variant="outline" className="text-[10px] mr-1">zypper</Badge>
                The security count is the number of needed security patches.
              </p>
            )}
          </>
        )}
      </CardContent>
      {patch && (
        <ApplyPatchesDialog
          open={applying}
          onOpenChange={setApplying}
          serverId={serverId}
          hostname={hostname}
          packageManager={patch.packageManager}
          securityCount={patch.securityCount}
          upgradableCount={patch.upgradableCount}
        />
      )}
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "danger" }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/3 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold truncate ${tone === "danger" ? "text-destructive" : ""}`}>{value}</div>
    </div>
  );
}
