import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ALERT_CHANNEL_TYPES,
  ALERT_CHANNEL_TYPE_LABELS,
  ALERT_EVENT_GROUPS,
  ALERT_EVENT_LABELS,
  ALERT_PRO_CHANNEL_TYPES,
  ALERT_SEVERITIES,
  DEFAULT_ALERT_EVENTS,
  type AlertChannelCreateInput,
  type AlertChannelDto,
  type AlertChannelFilters,
  type AlertChannelListResponse,
  type AlertChannelType,
  type AlertChannelUpdateInput,
  type AlertEventType,
  type AlertSeverity,
  type WebhookFormat,
} from "@inv/shared";
import { toast } from "sonner";
import { Loader2, Lock, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createAlertChannel,
  fetchAlertFilterServers,
  fetchAlertFilterTags,
  testAlertChannel,
  testAlertChannelDraft,
  updateAlertChannel,
} from "@/lib/alerts-api";
import { ChannelTypeIcon } from "./channel-type-icon";

/**
 * Create / edit an alert channel.
 *
 * Secrets are write-only: when editing, the URL / key / token inputs start
 * empty and "leave blank to keep" the stored value — the API never sends the
 * secret back, only a masked hint. Pro-only features (Teams, PagerDuty,
 * routing filters, custom templates) stay visible but disabled on the free
 * tier, with an upgrade hint, so the capability is discoverable.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing. */
  channel?: AlertChannelDto | null;
  license: AlertChannelListResponse["license"];
  emailConfigured: boolean;
  onSaved?: () => void;
}

interface HeaderRow {
  name: string;
  value: string;
}

const URL_HINTS: Partial<Record<AlertChannelType, { label: string; placeholder: string; help: string }>> = {
  slack: {
    label: "Incoming webhook URL",
    placeholder: "https://hooks.slack.com/services/T…/B…/…",
    help: "Slack → Apps → Incoming Webhooks. Slack-compatible hosts (Mattermost…) must be on ALERT_OUTBOUND_ALLOWLIST.",
  },
  teams: {
    label: "Workflows webhook URL",
    placeholder: "https://….logic.azure.com/workflows/…",
    help: 'Teams → Workflows → "Post to a channel when a webhook request is received". Legacy O365 connectors are not supported.',
  },
  discord: {
    label: "Webhook URL",
    placeholder: "https://discord.com/api/webhooks/…",
    help: "Channel settings → Integrations → Webhooks. Mentions in alert text are never pinged.",
  },
  webhook: {
    label: "Endpoint URL",
    placeholder: "https://hooks.example.com/rackmap",
    help: "HTTPS required unless ALERT_OUTBOUND_ALLOW_HTTP is set; private addresses need ALERT_OUTBOUND_ALLOW_PRIVATE or the allowlist.",
  },
};

function cfg(channel: AlertChannelDto | null | undefined, key: string): string {
  const v = channel?.config?.[key];
  return typeof v === "string" ? v : "";
}

function splitList(s: string): string[] {
  return s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function AlertChannelDialog({ open, onOpenChange, channel, license, emailConfigured, onSaved }: Props) {
  const editing = !!channel;
  const envManaged = channel?.managedBy === "env";
  const pro = license.multiChannel;

  const [type, setType] = useState<AlertChannelType | null>(null);
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [events, setEvents] = useState<Set<AlertEventType>>(new Set());
  // secrets (write-only)
  const [url, setUrl] = useState("");
  const [routingKey, setRoutingKey] = useState("");
  const [botToken, setBotToken] = useState("");
  const [hmacSecret, setHmacSecret] = useState("");
  const [clearHmac, setClearHmac] = useState(false);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [clearHeaders, setClearHeaders] = useState(false);
  // config
  const [chatId, setChatId] = useState("");
  const [region, setRegion] = useState<"us" | "eu">("us");
  const [mention, setMention] = useState<"none" | "here" | "channel">("none");
  const [format, setFormat] = useState<WebhookFormat>("default");
  const [template, setTemplate] = useState("");
  const [emails, setEmails] = useState("");
  // filters (Pro)
  const [filtersOn, setFiltersOn] = useState(false);
  const [serverIds, setServerIds] = useState<number[]>([]);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [environments, setEnvironments] = useState("");
  const [minSeverity, setMinSeverity] = useState<AlertSeverity | "any">("any");
  const [includeUnscoped, setIncludeUnscoped] = useState(true);
  const [serverQuery, setServerQuery] = useState("");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Reset the form whenever the dialog opens (for a new channel or a different one).
  useEffect(() => {
    if (!open) return;
    const t = (channel?.type ?? null) as AlertChannelType | null;
    setType(t);
    setName(channel?.name ?? "");
    setEnabled(channel?.enabled ?? true);
    setEvents(new Set(channel?.events ?? []));
    setUrl("");
    setRoutingKey("");
    setBotToken("");
    setHmacSecret("");
    setClearHmac(false);
    setHeaders([]);
    setClearHeaders(false);
    setChatId(cfg(channel, "chatId"));
    setRegion(cfg(channel, "region") === "eu" ? "eu" : "us");
    setMention((cfg(channel, "mention") as "none" | "here" | "channel") || "none");
    setFormat((cfg(channel, "format") as WebhookFormat) || "default");
    setTemplate(cfg(channel, "template"));
    setEmails(Array.isArray(channel?.config?.emails) ? (channel!.config.emails as string[]).join("\n") : "");
    const f = channel?.filters ?? null;
    setFiltersOn(!!f && (!!f.serverIds?.length || !!f.tagIds?.length || !!f.environments?.length || !!f.minSeverity));
    setServerIds(f?.serverIds ?? []);
    setTagIds(f?.tagIds ?? []);
    setEnvironments((f?.environments ?? []).join(", "));
    setMinSeverity(f?.minSeverity ?? "any");
    setIncludeUnscoped(f?.includeUnscoped ?? true);
    setServerQuery("");
  }, [open, channel]);

  const tagsQ = useQuery({ queryKey: ["tags", "alert-filters"], queryFn: fetchAlertFilterTags, enabled: open && filtersOn && pro });
  const serversQ = useQuery({
    queryKey: ["servers", "alert-filters", serverQuery],
    queryFn: () => fetchAlertFilterServers(serverQuery),
    enabled: open && filtersOn && pro,
  });

  const typeIsPro = !!type && ALERT_PRO_CHANNEL_TYPES.includes(type);
  const uiLimitReached = !editing && license.uiChannelLimit !== null && license.uiChannelCount >= license.uiChannelLimit;

  function pickType(t: AlertChannelType) {
    setType(t);
    if (!name) setName(ALERT_CHANNEL_TYPE_LABELS[t]);
    setEvents(new Set(DEFAULT_ALERT_EVENTS[t]));
  }

  function toggleEvent(e: AlertEventType, on: boolean) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (on) next.add(e);
      else next.delete(e);
      return next;
    });
  }

  const filters = useMemo<AlertChannelFilters | null>(() => {
    if (!filtersOn) return null;
    const envs = splitList(environments);
    return {
      ...(serverIds.length ? { serverIds } : {}),
      ...(tagIds.length ? { tagIds } : {}),
      ...(envs.length ? { environments: envs } : {}),
      ...(minSeverity !== "any" ? { minSeverity } : {}),
      includeUnscoped,
    };
  }, [filtersOn, serverIds, tagIds, environments, minSeverity, includeUnscoped]);

  function headerObject(): Record<string, string> | undefined {
    const rows = headers.filter((h) => h.name.trim());
    if (rows.length === 0) return undefined;
    return Object.fromEntries(rows.map((h) => [h.name.trim(), h.value]));
  }

  /** Non-secret config for the current type. */
  function configFor(t: AlertChannelType): Record<string, unknown> {
    switch (t) {
      case "slack":
        return { mention };
      case "pagerduty":
        return { region };
      case "telegram":
        return { chatId: chatId.trim() };
      case "webhook":
        return format === "template" ? { format, template } : { format };
      case "email":
        return { emails: splitList(emails) };
      default:
        return {};
    }
  }

  function buildCreate(): AlertChannelCreateInput | null {
    if (!type) return null;
    const base = { name: name.trim(), enabled, events: [...events], filters };
    switch (type) {
      case "slack":
        return { ...base, type, url: url.trim(), config: { mention } };
      case "teams":
        return { ...base, type, url: url.trim() };
      case "discord":
        return { ...base, type, url: url.trim() };
      case "pagerduty":
        return { ...base, type, routingKey: routingKey.trim(), config: { region } };
      case "telegram":
        return { ...base, type, botToken: botToken.trim(), config: { chatId: chatId.trim() } };
      case "webhook": {
        const h = headerObject();
        return {
          ...base,
          type,
          url: url.trim(),
          ...(hmacSecret ? { hmacSecret } : {}),
          ...(h ? { headers: h } : {}),
          config: configFor("webhook") as { format: WebhookFormat; template?: string },
        };
      }
      case "email":
        return { ...base, type, config: { emails: splitList(emails) } };
    }
  }

  function buildUpdate(): AlertChannelUpdateInput | null {
    if (!type || !channel) return null;
    if (envManaged) return { type, name: name.trim(), enabled, events: [...events] } as AlertChannelUpdateInput;
    const secret: Record<string, unknown> = {};
    if (url.trim()) secret.url = url.trim();
    if (routingKey.trim()) secret.routingKey = routingKey.trim();
    if (botToken.trim()) secret.botToken = botToken.trim();
    if (type === "webhook") {
      if (clearHmac) secret.hmacSecret = null;
      else if (hmacSecret) secret.hmacSecret = hmacSecret;
      const h = headerObject();
      if (clearHeaders) secret.headers = null;
      else if (h) secret.headers = h;
    }
    return {
      type,
      name: name.trim(),
      enabled,
      events: [...events],
      filters,
      ...(type === "teams" || type === "discord" ? {} : { config: configFor(type) }),
      ...secret,
    } as AlertChannelUpdateInput;
  }

  function validate(): string | null {
    if (!type) return "Pick a channel type";
    if (!name.trim()) return "Give the channel a name";
    if (events.size === 0) return "Subscribe to at least one event";
    if (!editing) {
      if ((type === "slack" || type === "teams" || type === "discord" || type === "webhook") && !url.trim()) return "The webhook URL is required";
      if (type === "pagerduty" && !routingKey.trim()) return "The routing key is required";
      if (type === "telegram" && !botToken.trim()) return "The bot token is required";
    }
    if (type === "telegram" && !chatId.trim()) return "The chat id is required";
    if (type === "email" && splitList(emails).length === 0) return "Add at least one recipient";
    if (type === "webhook" && format === "template") {
      try {
        const parsed = JSON.parse(template);
        if (parsed === null || typeof parsed !== "object") return "The template must be a JSON object or array";
      } catch {
        return "The template is not valid JSON";
      }
    }
    return null;
  }

  async function handleSave() {
    const problem = validate();
    if (problem) return void toast.error(problem);
    setSaving(true);
    try {
      if (editing && channel) {
        await updateAlertChannel(channel.id, buildUpdate()!);
        toast.success("Alert channel updated");
      } else {
        await createAlertChannel(buildCreate()!);
        toast.success("Alert channel created");
      }
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "Could not save the channel");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      let res;
      if (editing && channel) {
        // Secrets are write-only, so an edit tests what is SAVED.
        res = await testAlertChannel(channel.id);
      } else {
        const problem = validate();
        if (problem) {
          toast.error(problem);
          return;
        }
        res = await testAlertChannelDraft(buildCreate()!);
      }
      if (res.ok) toast.success(`Test delivered${res.statusCode ? ` (HTTP ${res.statusCode})` : ""} in ${res.durationMs}ms`);
      else toast.error(`Test failed: ${res.error ?? "unknown error"}`);
    } catch (err) {
      toast.error((err as Error).message || "Test failed");
    } finally {
      setTesting(false);
    }
  }

  const secretPlaceholder = (hint: string | null | undefined, fallback: string) =>
    editing ? (hint ? `${hint} — leave blank to keep` : "Leave blank to keep the current value") : fallback;

  const locked = envManaged; // env channels: only name / events / enabled

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${channel?.name}` : type ? `New ${ALERT_CHANNEL_TYPE_LABELS[type]} channel` : "New alert channel"}</DialogTitle>
          <DialogDescription>
            {envManaged
              ? `Managed by ${channel?.envKey ?? "environment variables"}: the destination comes from the environment and is re-synced at boot.`
              : "Where RackMap sends alerts, and which events it sends there."}
          </DialogDescription>
        </DialogHeader>

        {!type ? (
          <div className="space-y-3">
            {uiLimitReached && (
              <UpgradeHint text={`The free tier includes ${license.uiChannelLimit} alert channel. Upgrade to RackMap Pro for unlimited channels.`} />
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ALERT_CHANNEL_TYPES.map((t) => {
                const needsPro = ALERT_PRO_CHANNEL_TYPES.includes(t) && !pro;
                const disabled = needsPro || uiLimitReached;
                return (
                  <button
                    key={t}
                    type="button"
                    disabled={disabled}
                    onClick={() => pickType(t)}
                    className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-left text-sm transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChannelTypeIcon type={t} className="h-4 w-4" />
                    <span className="font-medium">{ALERT_CHANNEL_TYPE_LABELS[t]}</span>
                    {needsPro && (
                      <Badge variant="warning" className="ml-auto text-[10px] px-1.5 py-0">
                        Pro
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>
            {!emailConfigured && (
              <p className="text-[11px] text-muted-foreground">Email channels need SMTP_HOST configured on the API.</p>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {typeIsPro && !pro && (
              <UpgradeHint text={`${ALERT_CHANNEL_TYPE_LABELS[type]} channels require RackMap Pro. This channel's alerts are suppressed on the free tier.`} />
            )}

            {/* Basics */}
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
              <div className="space-y-1">
                <Label htmlFor="alert-name">Name</Label>
                <Input id="alert-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. #ops-alerts" />
              </div>
              <label className="flex items-center gap-2 text-sm pb-2">
                <Switch checked={enabled} onCheckedChange={setEnabled} /> Enabled
              </label>
            </div>

            {/* Destination */}
            <fieldset disabled={locked} className="space-y-3 disabled:opacity-60">
              {URL_HINTS[type] && (
                <div className="space-y-1">
                  <Label htmlFor="alert-url">{URL_HINTS[type]!.label}</Label>
                  <Input
                    id="alert-url"
                    type="password"
                    autoComplete="off"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={secretPlaceholder(channel?.secretHint, URL_HINTS[type]!.placeholder)}
                  />
                  <p className="text-[11px] text-muted-foreground">{URL_HINTS[type]!.help}</p>
                </div>
              )}

              {type === "slack" && (
                <div className="space-y-1">
                  <Label>Mention on critical/error alerts</Label>
                  <Select value={mention} onValueChange={(v) => setMention(v as typeof mention)}>
                    <SelectTrigger className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No mention</SelectItem>
                      <SelectItem value="here">@here</SelectItem>
                      <SelectItem value="channel">@channel</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {type === "pagerduty" && (
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="alert-rk">Integration (routing) key</Label>
                    <Input
                      id="alert-rk"
                      type="password"
                      autoComplete="off"
                      value={routingKey}
                      onChange={(e) => setRoutingKey(e.target.value)}
                      placeholder={secretPlaceholder(channel?.secretHint, "32-character Events API v2 key")}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Region</Label>
                    <Select value={region} onValueChange={(v) => setRegion(v as "us" | "eu")}>
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="us">US</SelectItem>
                        <SelectItem value="eu">EU</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="sm:col-span-2 text-[11px] text-muted-foreground">
                    Triggers carry a stable dedup key, and the matching recovery resolves the same incident.
                  </p>
                </div>
              )}

              {type === "telegram" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="alert-bot">Bot token</Label>
                    <Input
                      id="alert-bot"
                      type="password"
                      autoComplete="off"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      placeholder={secretPlaceholder(channel?.secretHint, "123456:ABC-DEF…")}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="alert-chat">Chat id</Label>
                    <Input id="alert-chat" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890 or @channel" />
                  </div>
                </div>
              )}

              {type === "email" && (
                <div className="space-y-1">
                  <Label htmlFor="alert-emails">Recipients</Label>
                  <Textarea
                    id="alert-emails"
                    rows={3}
                    value={emails}
                    onChange={(e) => setEmails(e.target.value)}
                    placeholder={"ops@example.com\noncall@example.com"}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    One per line or comma-separated.{!emailConfigured && " SMTP_HOST is not configured, so deliveries will fail until it is."}
                  </p>
                </div>
              )}

              {type === "webhook" && (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="alert-hmac">Signing secret (optional)</Label>
                    <Input
                      id="alert-hmac"
                      type="password"
                      autoComplete="off"
                      value={hmacSecret}
                      disabled={clearHmac}
                      onChange={(e) => setHmacSecret(e.target.value)}
                      placeholder={editing && channel?.hasHmacSecret ? "Set — leave blank to keep" : "At least 16 characters"}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Adds <code>X-Rackmap-Signature: sha256=HMAC(secret, timestamp + "." + body)</code>.
                    </p>
                    {editing && channel?.hasHmacSecret && (
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox checked={clearHmac} onCheckedChange={(v) => setClearHmac(v === true)} /> Remove the signing secret
                      </label>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label>Custom headers (write-only)</Label>
                      <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setHeaders((h) => [...h, { name: "", value: "" }])}>
                        <Plus className="h-3 w-3" /> Add
                      </Button>
                    </div>
                    {editing && (channel?.headerNames.length ?? 0) > 0 && headers.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        Stored: {channel!.headerNames.join(", ")}. Adding headers here replaces them.
                      </p>
                    )}
                    {headers.map((h, i) => (
                      <div key={i} className="flex gap-2">
                        <Input
                          className="w-40"
                          placeholder="Authorization"
                          value={h.name}
                          onChange={(e) => setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                        />
                        <Input
                          type="password"
                          autoComplete="off"
                          placeholder="value"
                          value={h.value}
                          onChange={(e) => setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                        />
                        <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" onClick={() => setHeaders((rows) => rows.filter((_, j) => j !== i))}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    {editing && (channel?.headerNames.length ?? 0) > 0 && (
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox checked={clearHeaders} onCheckedChange={(v) => setClearHeaders(v === true)} /> Remove all stored headers
                      </label>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label>Body format</Label>
                    <Select value={format} onValueChange={(v) => setFormat(v as WebhookFormat)}>
                      <SelectTrigger className="w-72">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">RackMap JSON (versioned)</SelectItem>
                        <SelectItem value="legacy_v1">Legacy (pre-0.9 NOTIFY_WEBHOOK_URL bodies)</SelectItem>
                        <SelectItem value="template" disabled={!pro}>
                          Custom JSON template{!pro ? " — Pro" : ""}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {format === "template" && (
                    <div className="space-y-1">
                      <Label htmlFor="alert-tpl">Template</Label>
                      <Textarea
                        id="alert-tpl"
                        rows={6}
                        className="font-mono text-xs"
                        value={template}
                        onChange={(e) => setTemplate(e.target.value)}
                        placeholder={'{\n  "text": "{{event.title}}",\n  "severity": "{{event.severity}}",\n  "details": "{{payload}}"\n}'}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Placeholders in string values: event.title, event.summary, event.severity, event.type, event.action, event.link, payload.…,
                        channel.name, delivery.id. A value that is exactly <code>{"{{payload}}"}</code> is inserted as raw JSON.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </fieldset>

            {/* Events */}
            <div className="space-y-2">
              <Label>Events</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {ALERT_EVENT_GROUPS.map((g) => (
                  <div key={g.label} className="rounded-lg border border-white/10 bg-white/3 p-3 space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</div>
                    {g.events.map((e) => (
                      <label key={e} className="flex items-center gap-2 text-xs cursor-pointer">
                        <Checkbox checked={events.has(e)} onCheckedChange={(v) => toggleEvent(e, v === true)} />
                        {ALERT_EVENT_LABELS[e]}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              {type === "pagerduty" && (
                <p className="text-[11px] text-muted-foreground">Every PagerDuty trigger pages someone; keep informational events off this channel.</p>
              )}
            </div>

            {/* Filters (Pro) */}
            {!locked && (
              <div className="space-y-2 rounded-lg border border-white/10 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      Routing filters
                      {!pro && (
                        <Badge variant="warning" className="text-[10px] px-1.5 py-0">
                          Pro
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">Only send alerts about matching servers, or above a severity.</p>
                  </div>
                  <Switch checked={filtersOn} disabled={!pro} onCheckedChange={setFiltersOn} />
                </div>
                {!pro && <UpgradeHint text="Per-channel routing filters require RackMap Pro." />}
                {filtersOn && pro && (
                  <div className="space-y-3 pt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="alert-envs">Environments</Label>
                        <Input id="alert-envs" value={environments} onChange={(e) => setEnvironments(e.target.value)} placeholder="production, staging" />
                      </div>
                      <div className="space-y-1">
                        <Label>Minimum severity</Label>
                        <Select value={minSeverity} onValueChange={(v) => setMinSeverity(v as AlertSeverity | "any")}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="any">Any</SelectItem>
                            {[...ALERT_SEVERITIES].reverse().map((s) => (
                              <SelectItem key={s} value={s}>
                                {s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label>Tags</Label>
                      <div className="flex flex-wrap gap-2">
                        {(tagsQ.data ?? []).map((t) => (
                          <label key={t.id} className="flex items-center gap-1.5 text-xs rounded border border-white/10 px-2 py-1 cursor-pointer">
                            <Checkbox
                              checked={tagIds.includes(t.id)}
                              onCheckedChange={(v) => setTagIds((ids) => (v === true ? [...ids, t.id] : ids.filter((x) => x !== t.id)))}
                            />
                            {t.name}
                          </label>
                        ))}
                        {tagsQ.data?.length === 0 && <span className="text-[11px] text-muted-foreground">No tags defined.</span>}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label>Servers {serverIds.length > 0 && <span className="text-muted-foreground">({serverIds.length} selected)</span>}</Label>
                      <Input value={serverQuery} onChange={(e) => setServerQuery(e.target.value)} placeholder="Search hostname or IP…" />
                      <div className="max-h-36 overflow-y-auto rounded border border-white/10 p-1.5 space-y-1">
                        {(serversQ.data?.items ?? []).map((s) => (
                          <label key={s.id} className="flex items-center gap-2 text-xs cursor-pointer px-1">
                            <Checkbox
                              checked={serverIds.includes(s.id)}
                              onCheckedChange={(v) => setServerIds((ids) => (v === true ? [...ids, s.id] : ids.filter((x) => x !== s.id)))}
                            />
                            <span className="font-medium">{s.hostname}</span>
                            <span className="text-muted-foreground font-mono">{s.ip}</span>
                          </label>
                        ))}
                        {serversQ.isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin m-1" />}
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox checked={includeUnscoped} onCheckedChange={(v) => setIncludeUnscoped(v === true)} />
                      Also send alerts that are not about a server (access requests, system notices)
                    </label>
                    <p className="text-[11px] text-muted-foreground">
                      Scope filters combine with AND. Recoveries always pass the severity filter so incidents close.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {type && (
              <Button type="button" variant="outline" size="sm" onClick={handleTest} disabled={testing || (typeIsPro && !pro)}>
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {editing ? "Send test (saved config)" : "Send test"}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {!editing && type && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setType(null)}>
                Back
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {type && (
              <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editing ? "Save" : "Create channel"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UpgradeHint({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
      <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>
        {text} <Lock className="inline h-3 w-3 -mt-0.5" /> Settings → Subscription.
      </span>
    </div>
  );
}
