import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ALERT_CHANNEL_TYPE_LABELS } from "@inv/shared";
import { toast } from "sonner";
import { Bell, Loader2, Mail, Send, Settings2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchMe, systemKeys } from "@/lib/queries";
import { alertsKeys, fetchServerAlertRouting, sendServerAlertTest } from "@/lib/alerts-api";
import { ChannelTypeIcon, HealthBadge } from "./channel-type-icon";

/**
 * Server detail: which alert channels this server's alerts reach (after each
 * channel's routing filters), plus a test button.
 *
 * The test sends a `test` event only — never a fake status flip, which would
 * be a server_down trigger and page whoever is on call via PagerDuty. It is
 * admin-only (alertChannel:manage) and only reaches channels subscribed to
 * "Test alerts".
 *
 * Replaces the old env-only AlertChannelsCard in _auth.servers.$serverId.tsx.
 */
export function ServerAlertChannelsCard({ serverId }: { serverId: number }) {
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 60_000 });
  const canManage = !!me?.can?.["alertChannel.manage"];
  const { data, isLoading, error } = useQuery({
    queryKey: alertsKeys.server(serverId),
    queryFn: () => fetchServerAlertRouting(serverId),
  });
  const [sending, setSending] = useState(false);

  async function handleTest() {
    setSending(true);
    try {
      const res = await sendServerAlertTest(serverId);
      if ((res.queued ?? 0) > 0) toast.success(res.message);
      else toast.warning(res.message);
    } catch (err) {
      toast.error((err as Error).message || "Could not send a test alert");
    } finally {
      setSending(false);
    }
  }

  const channels = data?.channels ?? [];
  const active = channels.filter((c) => c.enabled && c.licensed);

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0 gap-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Bell className="h-4 w-4 text-amber-500" />
          Alert routing
        </CardTitle>
        <div className="flex items-center gap-1.5">
          {canManage && (
            <Button asChild size="sm" variant="ghost" className="h-7 text-xs gap-1.5">
              <Link to="/settings">
                <Settings2 className="h-3.5 w-3.5" /> Manage
              </Link>
            </Button>
          )}
          {canManage && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={handleTest} disabled={sending || active.length === 0}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5 text-amber-500" />}
              Send test alert
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        <p className="text-xs text-muted-foreground">
          Down/up flips, metric thresholds, SSL expiry, heartbeats and runbook results for this server go to the channels below.
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking alert routing…
          </div>
        ) : error ? (
          <p className="text-xs text-destructive">{(error as Error).message}</p>
        ) : channels.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No alert channel covers this server yet.{canManage ? " Add one in Settings → Alerts." : ""}
          </p>
        ) : (
          <ul className="divide-y divide-white/5 rounded-lg border border-white/10">
            {channels.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                <ChannelTypeIcon type={c.type} className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium truncate">{c.name}</span>
                <span className="text-muted-foreground">{ALERT_CHANNEL_TYPE_LABELS[c.type]}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {c.managedBy === "env" && (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                      env
                    </Badge>
                  )}
                  {c.scoped && (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0" title="This channel's filters include this server">
                      filtered
                    </Badge>
                  )}
                  {!c.enabled ? (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      Disabled
                    </Badge>
                  ) : !c.licensed ? (
                    <Badge variant="warning" className="text-[10px]">
                      Needs Pro
                    </Badge>
                  ) : (
                    <HealthBadge status={c.health} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {data && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Mail className="h-3 w-3" />
            {data.email.configured
              ? `${data.preferenceEmailRecipients ?? 0} user${data.preferenceEmailRecipients === 1 ? "" : "s"} also get up/down email from their notification preferences.`
              : "SMTP is not configured, so preference emails are not sent."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
