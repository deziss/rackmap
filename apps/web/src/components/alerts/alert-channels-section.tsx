import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ALERT_CHANNEL_TYPE_LABELS, ALERT_EVENT_LABELS, type AlertChannelDto } from "@inv/shared";
import { toast } from "sonner";
import { BellRing, Loader2, Pencil, Plus, RefreshCw, ScrollText, Send, Sparkles, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { alertsKeys, deleteAlertChannel, fetchAlertChannels, testAlertChannel, updateAlertChannel } from "@/lib/alerts-api";
import { AlertChannelDialog } from "./alert-channel-dialog";
import { AlertDeliveryLog } from "./alert-delivery-log";
import { ChannelTypeIcon, HealthBadge } from "./channel-type-icon";

/** Settings → Alerts: every alert channel, its health, and the actions on it. Admin only. */
export function AlertChannelsSection() {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, refetch, error } = useQuery({ queryKey: alertsKeys.list(), queryFn: fetchAlertChannels });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AlertChannelDto | null>(null);
  const [logChannel, setLogChannel] = useState<AlertChannelDto | null>(null);
  const [deleting, setDeleting] = useState<AlertChannelDto | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: alertsKeys.all });

  const toggle = useMutation({
    mutationFn: (v: { id: number; enabled: boolean }) => updateAlertChannel(v.id, { enabled: v.enabled }),
    onSuccess: (_d, v) => {
      toast.success(v.enabled ? "Channel enabled" : "Channel disabled");
      invalidate();
    },
    onError: (err) => toast.error((err as Error).message || "Could not update the channel"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => deleteAlertChannel(id),
    onSuccess: () => {
      toast.success("Channel deleted");
      setDeleting(null);
      invalidate();
    },
    onError: (err) => toast.error((err as Error).message || "Could not delete the channel"),
  });

  async function runTest(ch: AlertChannelDto) {
    setTestingId(ch.id);
    try {
      const res = await testAlertChannel(ch.id);
      if (res.ok) toast.success(`Test delivered to ${ch.name}${res.statusCode ? ` (HTTP ${res.statusCode})` : ""}`);
      else toast.error(`Test to ${ch.name} failed: ${res.error ?? "unknown error"}`);
      invalidate();
    } catch (err) {
      toast.error((err as Error).message || "Test failed");
    } finally {
      setTestingId(null);
    }
  }

  const license = data?.license ?? { multiChannel: false, uiChannelLimit: 1, uiChannelCount: 0 };
  const items = data?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-lg flex items-center gap-2">
            <BellRing className="h-5 w-5 text-amber-500" /> Alert channels
          </CardTitle>
          <CardDescription>
            Slack, Teams, Discord, PagerDuty, Telegram, email and signed webhooks. Deliveries are queued, retried with backoff and logged.
          </CardDescription>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching} title="Refresh">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Add channel
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!license.multiChannel && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Free tier: {license.uiChannelCount}/{license.uiChannelLimit} channel used, plus any NOTIFY_* environment channels. RackMap Pro adds unlimited channels,
              Teams, PagerDuty, routing filters and custom webhook templates.
            </span>
          </div>
        )}
        {data && !data.publicBaseUrl && (
          <p className="text-[11px] text-muted-foreground">
            Set PUBLIC_BASE_URL on the API to include "Open in RackMap" links in alert messages.
          </p>
        )}

        <div className="rounded-lg border border-white/10 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <th className="px-3 py-2.5">Channel</th>
                <th className="px-3 py-2.5">Events</th>
                <th className="px-3 py-2.5">Health</th>
                <th className="px-3 py-2.5">Enabled</th>
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="inline h-4 w-4 animate-spin" />
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-destructive text-xs">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && !error && items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground text-xs">
                    No alert channels yet. Add one to get server, heartbeat and runbook alerts where your team works.
                  </td>
                </tr>
              )}
              {items.map((ch) => (
                <tr key={ch.id} className="border-b border-white/5 last:border-0 hover:bg-white/4 transition-colors">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <ChannelTypeIcon type={ch.type} className="h-4 w-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{ch.name}</div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                          <span>{ALERT_CHANNEL_TYPE_LABELS[ch.type]}</span>
                          {ch.secretHint && <span className="font-mono truncate max-w-[14rem]">{ch.secretHint}</span>}
                          {ch.managedBy === "env" && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0" title={`Managed by ${ch.envKey ?? "environment"}`}>
                              env
                            </Badge>
                          )}
                          {ch.filters && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                              filtered
                            </Badge>
                          )}
                          {!ch.licensed && (
                            <Badge variant="warning" className="text-[9px] px-1.5 py-0" title="Deliveries are suppressed on the current license">
                              needs Pro
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs text-muted-foreground" title={ch.events.map((e) => ALERT_EVENT_LABELS[e] ?? e).join("\n")}>
                      {ch.events.length} event{ch.events.length === 1 ? "" : "s"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <HealthBadge
                      status={ch.health.status}
                      title={ch.health.lastError ? `Last error: ${ch.health.lastError}` : ch.health.lastSuccessAt ? `Last success ${new Date(ch.health.lastSuccessAt).toLocaleString()}` : undefined}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <Switch
                      checked={ch.enabled}
                      disabled={toggle.isPending}
                      onCheckedChange={(v) => toggle.mutate({ id: ch.id, enabled: v })}
                      aria-label={`Enable ${ch.name}`}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Send test" disabled={testingId === ch.id || !ch.licensed} onClick={() => runTest(ch)}>
                        {testingId === ch.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Edit"
                        onClick={() => {
                          setEditing(ch);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Delivery log" onClick={() => setLogChannel(ch)}>
                        <ScrollText className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title={ch.managedBy === "env" ? `Unset ${ch.envKey ?? "the env variable"} and restart to remove` : "Delete"}
                        disabled={ch.managedBy === "env"}
                        onClick={() => setDeleting(ch)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>

      <AlertChannelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        channel={editing}
        license={license}
        emailConfigured={data?.emailConfigured ?? false}
        onSaved={invalidate}
      />
      <AlertDeliveryLog channel={logChannel} open={!!logChannel} onOpenChange={(o) => !o && setLogChannel(null)} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Alerts stop going to this channel immediately. Its delivery log is deleted with it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove.mutate(deleting.id)} disabled={remove.isPending}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
