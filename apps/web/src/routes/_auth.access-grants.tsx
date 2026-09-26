import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ACCESS_GRANT_STATUSES, type AccessGrantDto, type AccessGrantKind, type AccessGrantStatus } from "@inv/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Ban, CalendarClock, KeyRound, Plus, Search, Timer, UserRound } from "lucide-react";
import { accessGrantKeys, fetchAccessGrants } from "@/lib/access-grants-api";
import { GrantAccessDialog } from "@/components/access-grants/grant-dialog";
import { ExtendGrantDialog, RevokeGrantDialog } from "@/components/access-grants/grant-actions";
import {
  AccessGrantStatusBadge,
  ExpiryCountdown,
  describeGrantAccess,
  formatDateTime,
  useAccessGrantPermissions,
  useNow,
} from "@/components/access-grants/grant-status";

export const Route = createFileRoute("/_auth/access-grants")({
  component: AccessGrantsPage,
});

const STATUS_LABEL: Record<AccessGrantStatus, string> = {
  active: "Active",
  expired_pending: "In progress",
  revoked: "Revoked",
  failed: "Revoke failed",
};

// Failed first (someone must act), then live grants by soonest expiry, then history.
function sortRank(g: AccessGrantDto): number {
  if (g.status === "failed") return 0;
  if (g.status === "active" || g.status === "expired_pending") return 1;
  return 2;
}

function AccessGrantsPage() {
  const perms = useAccessGrantPermissions();
  const now = useNow(1000);
  const [status, setStatus] = useState<AccessGrantStatus | "all">("all");
  const [kind, setKind] = useState<AccessGrantKind | "all">("all");
  const [search, setSearch] = useState("");
  const [granting, setGranting] = useState(false);
  const [extending, setExtending] = useState<AccessGrantDto | null>(null);
  const [revoking, setRevoking] = useState<AccessGrantDto | null>(null);

  const params = { ...(status === "all" ? {} : { status }), ...(kind === "all" ? {} : { kind }) };
  const { data, isLoading, error } = useQuery({
    queryKey: accessGrantKeys.list(params),
    queryFn: () => fetchAccessGrants(params),
    enabled: perms.canRead,
    refetchInterval: 15_000,
  });

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items ?? [])
      .filter(
        (g) =>
          !q ||
          g.username.toLowerCase().includes(q) ||
          g.server?.hostname.toLowerCase().includes(q) ||
          g.reason?.toLowerCase().includes(q) ||
          g.keyFingerprint?.toLowerCase().includes(q) ||
          g.createdBy?.email.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const r = sortRank(a) - sortRank(b);
        if (r !== 0) return r;
        if (sortRank(a) === 1) return a.expiresAt.localeCompare(b.expiresAt);
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [data?.items, search]);

  const failed = (data?.items ?? []).filter((g) => g.status === "failed");
  const liveCount = (data?.items ?? []).filter((g) => g.status === "active").length;

  if (perms.loaded && !perms.canRead) {
    return <div className="p-6 text-sm text-muted-foreground">You do not have permission to view access grants.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-4 bg-card/40 backdrop-blur-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Timer className="h-5 w-5 text-primary" /> Access grants
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Temporary accounts and SSH keys that RackMap removes automatically when they expire.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search user, server, reason…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 pr-2 text-xs bg-zinc-900/60 border-zinc-700"
            />
          </div>
          <Select value={kind} onValueChange={(v) => setKind(v as AccessGrantKind | "all")}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Users and keys</SelectItem>
              <SelectItem value="os_user">Temporary users</SelectItem>
              <SelectItem value="ssh_key">Temporary keys</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as AccessGrantStatus | "all")}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {ACCESS_GRANT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {perms.canCreate && (
            <Button size="sm" onClick={() => setGranting(true)}>
              <Plus className="h-4 w-4 mr-1" /> Grant access
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {failed.length > 0 && (
          <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
            <span>
              <strong>
                {failed.length} grant{failed.length === 1 ? "" : "s"} could not be revoked.
              </strong>{" "}
              The access may still work on the host. Fix the cause shown on the row (unreachable host, locked vault, sudo) and press
              Revoke to retry.
            </span>
          </div>
        )}
        {error && (
          <div className="px-3.5 py-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">{(error as Error).message}</div>
        )}
        {liveCount > 0 && (
          <div className="text-xs text-muted-foreground">
            {liveCount} active grant{liveCount === 1 ? "" : "s"}
          </div>
        )}

        <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/3">
                {["Status", "Access", "Server", "Expires", "Granted by", "Reason"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {h}
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-white/5">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-3 py-3">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-muted-foreground text-sm">
                    {data?.items.length
                      ? "No grants match."
                      : "No access grants yet. Grant a temporary account or key from here or from a server's page."}
                  </td>
                </tr>
              )}
              {items.map((g) => (
                <tr key={g.id} className="border-b border-white/5 last:border-0 hover:bg-white/4 align-top">
                  <td className="px-3 py-3 whitespace-nowrap">
                    <AccessGrantStatusBadge grant={g} now={now} />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      {g.kind === "ssh_key" ? (
                        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="font-mono text-xs font-medium">{g.username}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">{describeGrantAccess(g)}</div>
                    {g.keyFingerprint && <div className="font-mono text-[10px] text-muted-foreground truncate max-w-[220px]" title={g.keyFingerprint}>{g.keyFingerprint}</div>}
                    {g.lastError && g.status !== "revoked" && (
                      <div className="mt-1 max-w-[320px] text-[11px] text-red-400 break-words">{g.lastError}</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {g.server ? (
                      <Link to="/servers/$serverId" params={{ serverId: String(g.server.id) }} className="hover:underline">
                        {g.server.hostname}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap">
                    <ExpiryCountdown grant={g} now={now} />
                    {(g.status === "active" || g.status === "expired_pending") && (
                      <div className="text-[10px] text-muted-foreground">{formatDateTime(g.expiresAt)}</div>
                    )}
                    {g.status === "revoked" && g.revokedAt && (
                      <div className="text-[10px] text-muted-foreground">
                        revoked {formatDateTime(g.revokedAt)}
                        {g.revokedBy ? ` by ${g.revokedBy.name}` : " automatically"}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {g.createdBy ? <span title={g.createdBy.email}>{g.createdBy.name}</span> : <span className="text-muted-foreground">—</span>}
                    <div className="text-[10px] text-muted-foreground">{formatDateTime(g.createdAt)}</div>
                  </td>
                  <td className="px-3 py-3 text-xs max-w-[260px]">
                    <div className="line-clamp-2" title={g.reason ?? undefined}>
                      {g.reason ?? <span className="text-muted-foreground">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {g.canExtend && (
                        <Button size="icon" variant="ghost" className="h-7 w-7" title="Change expiry" onClick={() => setExtending(g)}>
                          <CalendarClock className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {g.canRevoke && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-rose-400 hover:bg-rose-500/20"
                          title={g.status === "failed" ? "Retry revoke" : "Revoke now"}
                          onClick={() => setRevoking(g)}
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <GrantAccessDialog open={granting} onOpenChange={setGranting} />
      <ExtendGrantDialog grant={extending} onOpenChange={(o) => !o && setExtending(null)} />
      <RevokeGrantDialog grant={revoking} onOpenChange={(o) => !o && setRevoking(null)} />
    </div>
  );
}
