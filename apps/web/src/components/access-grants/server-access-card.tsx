import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { AccessGrantDto } from "@inv/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Ban, CalendarClock, KeyRound, Loader2, Plus, Timer, UserRound } from "lucide-react";
import { accessGrantKeys, fetchAccessGrants } from "@/lib/access-grants-api";
import { GrantAccessDialog } from "./grant-dialog";
import { ExtendGrantDialog, RevokeGrantDialog } from "./grant-actions";
import { AccessGrantStatusBadge, ExpiryCountdown, useAccessGrantPermissions, useNow } from "./grant-status";

/** Live and recent temporary access on one server, for the server detail page. */
export function ServerAccessCard({ serverId }: { serverId: number }) {
  const perms = useAccessGrantPermissions();
  const now = useNow(1000);
  const [granting, setGranting] = useState(false);
  const [extending, setExtending] = useState<AccessGrantDto | null>(null);
  const [revoking, setRevoking] = useState<AccessGrantDto | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: accessGrantKeys.list({ serverId }),
    queryFn: () => fetchAccessGrants({ serverId }),
    enabled: perms.canRead,
    refetchInterval: 15_000,
  });

  if (perms.loaded && !perms.canRead) return null;

  const all = data?.items ?? [];
  const live = all.filter((g) => g.status !== "revoked");
  const recent = all.filter((g) => g.status === "revoked").slice(0, 3);

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Timer className="h-4 w-4 text-sky-400" />
          Temporary access
          {live.length > 0 && <span className="text-xs font-normal text-muted-foreground">({live.length})</span>}
        </CardTitle>
        {perms.canCreate && (
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setGranting(true)}>
            <Plus className="h-3.5 w-3.5" /> Grant access
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-4 pt-2">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading grants…
          </div>
        ) : all.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No temporary access on this server. Grant a contractor an account or a key that RackMap removes automatically when it expires.
          </p>
        ) : (
          <ul className="divide-y divide-white/5">
            {[...live, ...recent].map((g) => (
              <li key={g.id} className="flex items-center gap-3 py-2">
                {g.kind === "ssh_key" ? (
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-medium">{g.username}</span>
                    <AccessGrantStatusBadge grant={g} now={now} />
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground" title={g.reason ?? undefined}>
                    <ExpiryCountdown grant={g} now={now} />
                    {g.reason ? ` · ${g.reason}` : ""}
                  </div>
                  {g.lastError && g.status !== "revoked" && (
                    <div className="truncate text-[11px] text-red-400" title={g.lastError}>
                      {g.lastError}
                    </div>
                  )}
                </div>
                <div className="flex gap-1">
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
                      title="Revoke now"
                      onClick={() => setRevoking(g)}
                    >
                      <Ban className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {all.length > 0 && (
          <Link to="/access-grants" className="mt-2 inline-block text-[11px] text-muted-foreground hover:underline">
            All access grants →
          </Link>
        )}
      </CardContent>
      <GrantAccessDialog open={granting} onOpenChange={setGranting} serverId={serverId} />
      <ExtendGrantDialog grant={extending} onOpenChange={(o) => !o && setExtending(null)} />
      <RevokeGrantDialog grant={revoking} onOpenChange={(o) => !o && setRevoking(null)} />
    </Card>
  );
}
