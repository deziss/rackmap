import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HeartbeatCreateInput,
  HeartbeatUpdateInput,
  isValidHeartbeatTimeZone,
  normalizeHeartbeatSchedule,
  type HeartbeatCreatedResponse,
  type HeartbeatDto,
  type HeartbeatKind,
} from "@inv/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CronExpressionInput } from "@/components/cron/cron-expression-input";
import { AlertCircle, AlertTriangle, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { fetchServers, serverKeys } from "@/lib/queries";
import { createHeartbeat, heartbeatKeys, updateHeartbeat } from "@/lib/heartbeats-api";
import { copyText } from "./heartbeat-status";

/**
 * Create or edit a heartbeat. On create the dialog switches to a one-time view of
 * the ping URL — the token is the job's only credential.
 */

interface HeartbeatFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing. */
  heartbeat?: HeartbeatDto | null;
  /** Pre-selects the server (e.g. from the server detail page). */
  defaultServerId?: number;
  onSaved?: (heartbeat: HeartbeatDto) => void;
}

type PeriodUnit = "min" | "h" | "d";
const UNIT_SECONDS: Record<PeriodUnit, number> = { min: 60, h: 3600, d: 86400 };

function splitPeriod(sec: number | null | undefined): { value: string; unit: PeriodUnit } {
  if (!sec) return { value: "1", unit: "h" };
  if (sec % 86400 === 0) return { value: String(sec / 86400), unit: "d" };
  if (sec % 3600 === 0) return { value: String(sec / 3600), unit: "h" };
  return { value: String(Math.max(1, Math.round(sec / 60))), unit: "min" };
}

const minutesToSec = (v: string) => Math.round(Number(v) * 60);
const secToMinutes = (s: number | null | undefined) => (s === null || s === undefined ? "" : String(Math.round((s / 60) * 100) / 100));

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function HeartbeatFormDialog({ open, onOpenChange, heartbeat, defaultServerId, onSaved }: HeartbeatFormDialogProps) {
  const qc = useQueryClient();
  const isEdit = !!heartbeat;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [serverId, setServerId] = useState<string>("none");
  const [kind, setKind] = useState<HeartbeatKind>("cron");
  const [schedule, setSchedule] = useState("*/5 * * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [periodValue, setPeriodValue] = useState("1");
  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>("h");
  const [graceMinutes, setGraceMinutes] = useState("5");
  const [maxRuntimeMinutes, setMaxRuntimeMinutes] = useState("");
  const [notifyOnLate, setNotifyOnLate] = useState(false);
  const [resumeOnPing, setResumeOnPing] = useState(true);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<HeartbeatCreatedResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setCreated(null);
    setCopied(false);
    const p = splitPeriod(heartbeat?.periodSeconds);
    setName(heartbeat?.name ?? "");
    setDescription(heartbeat?.description ?? "");
    setServerId(heartbeat?.serverId ? String(heartbeat.serverId) : defaultServerId ? String(defaultServerId) : "none");
    setKind(heartbeat?.kind ?? "cron");
    setSchedule(heartbeat?.schedule ?? "*/5 * * * *");
    setTimezone(heartbeat?.timezone ?? browserTimeZone());
    setPeriodValue(p.value);
    setPeriodUnit(p.unit);
    setGraceMinutes(secToMinutes(heartbeat?.graceSeconds ?? 300));
    setMaxRuntimeMinutes(secToMinutes(heartbeat?.maxRuntimeSeconds));
    setNotifyOnLate(heartbeat?.notifyOnLate ?? false);
    setResumeOnPing(heartbeat?.resumeOnPing ?? true);
  }, [open, heartbeat, defaultServerId]);

  const { data: servers } = useQuery({
    queryKey: serverKeys.list({ picker: true, limit: 1000 }),
    queryFn: () => fetchServers({ limit: 1000 }),
    enabled: open,
    staleTime: 60_000,
  });

  const timeZones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [] as string[];
    }
  }, []);

  const cronLinked = !!heartbeat?.cronSource;

  const payload = {
    name: name.trim(),
    description: description.trim() || null,
    serverId: serverId === "none" ? null : Number(serverId),
    kind,
    schedule: kind === "cron" ? schedule.trim() : null,
    timezone: timezone.trim(),
    periodSeconds: kind === "period" ? Math.round(Number(periodValue) * UNIT_SECONDS[periodUnit]) : null,
    graceSeconds: minutesToSec(graceMinutes || "0"),
    maxRuntimeSeconds: maxRuntimeMinutes.trim() ? minutesToSec(maxRuntimeMinutes) : null,
    notifyOnLate,
    resumeOnPing,
  };

  const errors = (() => {
    const out: string[] = [];
    if (!payload.name) out.push("Name is required");
    if (kind === "cron") {
      const s = normalizeHeartbeatSchedule(payload.schedule ?? "");
      if (!s.ok) out.push(s.error);
    } else if (!payload.periodSeconds || !Number.isFinite(payload.periodSeconds) || payload.periodSeconds < 60) {
      out.push("Period must be at least 1 minute");
    }
    if (!isValidHeartbeatTimeZone(payload.timezone)) out.push(`Unknown time zone "${payload.timezone}"`);
    if (!Number.isFinite(payload.graceSeconds) || payload.graceSeconds < 0) out.push("Grace period must be 0 or more minutes");
    if (payload.maxRuntimeSeconds !== null && (!Number.isFinite(payload.maxRuntimeSeconds) || payload.maxRuntimeSeconds < 1)) {
      out.push("Max runtime must be a positive number of minutes");
    }
    if (out.length === 0) {
      const parsed = (isEdit ? HeartbeatUpdateInput : HeartbeatCreateInput).safeParse(payload);
      if (!parsed.success) out.push(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    return out;
  })();

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit) return { kind: "updated" as const, res: await updateHeartbeat(heartbeat!.id, payload) };
      return { kind: "created" as const, res: await createHeartbeat(payload) };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: heartbeatKeys.all });
      if (r.kind === "created") {
        setCreated(r.res);
        onSaved?.(r.res.heartbeat);
        toast.success("Heartbeat created");
      } else {
        onSaved?.(r.res.heartbeat);
        toast.success("Heartbeat updated");
        onOpenChange(false);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submit = () => {
    setTouched(true);
    if (errors.length === 0) mutation.mutate();
  };

  if (created) {
    const url = created.pingUrl;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Heartbeat created</DialogTitle>
            <DialogDescription>
              Have the job request this URL when it finishes. Append <code className="font-mono">/start</code> before it runs to record durations,{" "}
              <code className="font-mono">/fail</code> or <code className="font-mono">/&lt;exit code&gt;</code> to report failures.
            </DialogDescription>
          </DialogHeader>
          {url ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button
                size="icon"
                variant="outline"
                title="Copy ping URL"
                onClick={async () => {
                  if (await copyText(url)) {
                    setCopied(true);
                    toast.success("Ping URL copied");
                  }
                }}
              >
                {copied ? <Check className="text-emerald-500" /> : <Copy />}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
                <span>{created.warning ?? "PUBLIC_BASE_URL is not set, so no ping URL can be shown."}</span>
              </div>
              <Label className="text-xs">Token</Label>
              <Input readOnly value={created.token} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <p className="text-[11px] text-muted-foreground">
                Ping path: <code className="font-mono">/api/v1/ping/&lt;token&gt;</code> on this instance's external URL.
              </p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Anyone with this URL can report for the job. Editors can see it again on the heartbeat's page, and rotate it there.
          </p>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit heartbeat" : "New heartbeat"}</DialogTitle>
          <DialogDescription>
            A heartbeat alerts when a job stops checking in on schedule, or checks in with a failure.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly database backup" maxLength={120} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Server</Label>
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Not linked" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not linked to a server</SelectItem>
                  {servers?.items.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.hostname} <span className="text-muted-foreground">({s.ip})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} placeholder="What the job does, who owns it, the runbook link…" />
          </div>

          {cronLinked && (
            <div className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 p-2.5 text-xs text-sky-300">
              <AlertCircle className="h-4 w-4 shrink-0 mt-px" />
              <span>
                This heartbeat was created from a crontab entry. Changing the schedule here does not change the crontab — edit the job in the server's Cron tab.
              </span>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-xs">Expected</Label>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant={kind === "cron" ? "default" : "outline"} onClick={() => setKind("cron")}>
                On a cron schedule
              </Button>
              <Button type="button" size="sm" variant={kind === "period" ? "default" : "outline"} onClick={() => setKind("period")}>
                Every fixed period
              </Button>
            </div>
            {kind === "cron" ? (
              <CronExpressionInput value={schedule} onChange={setSchedule} timezone={isValidHeartbeatTimeZone(timezone) ? timezone : "UTC"} />
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Every</span>
                <Input type="number" min={1} className="w-24" value={periodValue} onChange={(e) => setPeriodValue(e.target.value)} />
                <Select value={periodUnit} onValueChange={(v) => setPeriodUnit(v as PeriodUnit)}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="min">minutes</SelectItem>
                    <SelectItem value="h">hours</SelectItem>
                    <SelectItem value="d">days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Time zone</Label>
              <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} list="heartbeat-timezones" disabled={kind === "period"} />
              <datalist id="heartbeat-timezones">
                {timeZones.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
              <p className="text-[11px] text-muted-foreground">The zone the job's host runs cron in.</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Grace (minutes)</Label>
              <Input type="number" min={0} step="any" value={graceMinutes} onChange={(e) => setGraceMinutes(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">How long after the expected time before it is down.</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max runtime (minutes)</Label>
              <Input type="number" min={0} step="any" value={maxRuntimeMinutes} onChange={(e) => setMaxRuntimeMinutes(e.target.value)} placeholder="= grace" />
              <p className="text-[11px] text-muted-foreground">After a /start ping, how long the run may take.</p>
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-white/3 p-2.5">
              <div>
                <div className="text-xs font-medium">Alert when late</div>
                <div className="text-[11px] text-muted-foreground">Also send an alert when the expected time passes, before the grace period ends.</div>
              </div>
              <Switch checked={notifyOnLate} onCheckedChange={setNotifyOnLate} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-white/3 p-2.5">
              <div>
                <div className="text-xs font-medium">Resume on ping</div>
                <div className="text-[11px] text-muted-foreground">A paused heartbeat starts monitoring again when the job next checks in.</div>
              </div>
              <Switch checked={resumeOnPing} onCheckedChange={setResumeOnPing} />
            </label>
          </div>

          {touched && errors.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 space-y-1">
              {errors.map((e) => (
                <div key={e} className="flex items-start gap-1.5 text-[11px] text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
                  <span>{e}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : isEdit ? "Save" : "Create heartbeat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
