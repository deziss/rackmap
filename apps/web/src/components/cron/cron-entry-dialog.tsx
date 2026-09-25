import { useEffect, useMemo, useState } from "react";
import {
  CRON_MAX_LINE_LENGTH,
  CRON_USERNAME_PATTERN,
  formatCronEntry,
  validateCronSchedule,
  type CronEntryLine,
  type CronKind,
} from "@inv/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Clock, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { CronExpressionInput } from "./cron-expression-input";
import {
  CronMonitorFields,
  DEFAULT_CRON_MONITOR_VALUE,
  type CronMonitorValue,
} from "@/components/heartbeats/cron-monitor-fields";

/** What the dialog hands back; the caller turns it into a crontab line. */
export interface CronEntryDraft {
  schedule: string;
  /** System crontabs only. */
  user?: string;
  command: string;
  label?: string;
  disabled: boolean;
}

export type CronEntryDialogMode = "add" | "edit" | "duplicate";

interface CronEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: number;
  kind: CronKind;
  /** Host timezone (or the CRON_TZ in effect) for the next-run preview. */
  timezone: string;
  mode: CronEntryDialogMode;
  /** The entry being edited or duplicated. */
  initial?: CronEntryLine | null;
  /** Called with the finished entry and the heartbeat choices from <CronMonitorFields/>. */
  onSave: (entry: CronEntryDraft, monitor: CronMonitorValue) => void;
}

const LOG_DIR = "/var/log/rackmap-cron";

function logSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "job"
  );
}

/** Index of the first `%` cron would treat as the start of stdin, or -1. */
function firstUnescapedPercent(command: string): number {
  for (let i = 0; i < command.length; i++) {
    if (command[i] === "\\" && command[i + 1] === "%") {
      i++;
      continue;
    }
    if (command[i] === "%") return i;
  }
  return -1;
}

/**
 * `"${SHELL:-/bin/sh}" -c '<cmd>' >> /var/log/rackmap-cron/<slug>.log 2>&1<stdin>`.
 * Quoting the command makes the redirect cover a whole list/pipeline; the `%`
 * stdin part stays outside the quotes because cron splits on it first.
 */
function wrapWithLog(command: string, label: string): string {
  const idx = firstUnescapedPercent(command);
  const cmd = idx < 0 ? command : command.slice(0, idx);
  const stdin = idx < 0 ? "" : command.slice(idx);
  const quoted = cmd.trim().replace(/'/g, "'\\''");
  return `"\${SHELL:-/bin/sh}" -c '${quoted}' >> ${LOG_DIR}/${logSlug(label)}.log 2>&1${stdin}`;
}

const LOG_WRAPPER = /^"\$\{SHELL:-\/bin\/sh\}" -c '((?:[^']|'\\'')*)' >> \/var\/log\/rackmap-cron\/[a-z0-9-]+\.log 2>&1(%.*)?$/s;

function unwrapLog(command: string): { command: string; logged: boolean } {
  const m = LOG_WRAPPER.exec(command);
  if (!m) return { command, logged: false };
  return { command: m[1]!.replace(/'\\''/g, "'") + (m[2] ?? ""), logged: true };
}

function dailyAt(time: string): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  return m ? `${Number(m[2])} ${Number(m[1])} * * *` : null;
}

export function CronEntryDialog({ open, onOpenChange, serverId, kind, timezone, mode, initial, onSave }: CronEntryDialogProps) {
  const [schedule, setSchedule] = useState("*/5 * * * *");
  const [user, setUser] = useState("root");
  const [command, setCommand] = useState("");
  const [label, setLabel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [logOutput, setLogOutput] = useState(false);
  const [dailyTime, setDailyTime] = useState("03:00");
  const [monitor, setMonitor] = useState<CronMonitorValue>(DEFAULT_CRON_MONITOR_VALUE);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    if (initial) {
      const unwrapped = unwrapLog(initial.command);
      setSchedule(initial.schedule);
      setUser(initial.user ?? "root");
      setCommand(unwrapped.command);
      setLogOutput(unwrapped.logged);
      setLabel(mode === "duplicate" && initial.label ? `${initial.label} (copy)` : initial.label ?? "");
      setEnabled(!initial.disabled);
      setMonitor(
        mode === "edit" && initial.heartbeatId !== undefined
          ? { ...DEFAULT_CRON_MONITOR_VALUE, enabled: true }
          : DEFAULT_CRON_MONITOR_VALUE,
      );
    } else {
      setSchedule("*/5 * * * *");
      setUser("root");
      setCommand("");
      setLabel("");
      setEnabled(true);
      setLogOutput(false);
      setMonitor(DEFAULT_CRON_MONITOR_VALUE);
    }
  }, [open, initial, mode]);

  const finalCommand = logOutput && command.trim() ? wrapWithLog(command, label) : command;
  const errors = useMemo(() => {
    const out: string[] = [];
    const s = validateCronSchedule(schedule);
    if (!s.ok) out.push(`Schedule: ${s.error}`);
    if (!command.trim()) out.push("Command is required");
    if (/[\r\n]/.test(command)) out.push("The command must be a single line (cron has no line continuation)");
    if (kind === "system" && (!user || user.length > 32 || !CRON_USERNAME_PATTERN.test(user))) out.push("Enter a valid Linux user to run as");
    if (/[\r\n]/.test(label)) out.push("The label must be a single line");
    if (logOutput && !label.trim()) out.push("Logging to a file needs a label (it names the log file)");
    const line = formatCronEntry({ schedule, user, command: finalCommand, disabled: false }, kind);
    if (line.length > CRON_MAX_LINE_LENGTH) {
      out.push(`The line is ${line.length} characters; cron refuses lines over ${CRON_MAX_LINE_LENGTH} — move the command into a script`);
    }
    return out;
  }, [schedule, command, kind, user, label, logOutput, finalCommand]);

  const presets: { label: string; value: string }[] = [
    { label: "Every 5 min", value: "*/5 * * * *" },
    { label: "Hourly", value: "0 * * * *" },
    { label: "Weekly", value: "0 0 * * 0" },
    { label: "Monthly", value: "0 0 1 * *" },
    { label: "@reboot", value: "@reboot" },
  ];

  const handleSave = () => {
    setTouched(true);
    if (errors.length) return;
    const draft: CronEntryDraft = { schedule: schedule.trim(), command: finalCommand, disabled: !enabled };
    if (kind === "system") draft.user = user;
    if (label.trim()) draft.label = label.trim();
    onSave(draft, monitor);
    onOpenChange(false);
  };

  const title = mode === "edit" ? "Edit cron job" : mode === "duplicate" ? "Duplicate cron job" : "Add cron job";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg">{title}</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Changes are staged in the editor; nothing is written to the host until you press Save.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label className="text-xs font-semibold">Schedule</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setSchedule(p.value)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                    schedule.trim() === p.value ? "border-primary/50 bg-primary/15 text-primary" : "border-white/10 hover:bg-white/5",
                  )}
                >
                  {p.label}
                </button>
              ))}
              <div className="flex items-center gap-1 rounded-full border border-white/10 pl-2.5 pr-1 py-0.5">
                <button
                  type="button"
                  className="text-[11px]"
                  onClick={() => {
                    const v = dailyAt(dailyTime);
                    if (v) setSchedule(v);
                  }}
                >
                  Daily at
                </button>
                <input
                  type="time"
                  value={dailyTime}
                  onChange={(e) => {
                    setDailyTime(e.target.value);
                    const v = dailyAt(e.target.value);
                    if (v) setSchedule(v);
                  }}
                  className="bg-transparent text-[11px] font-mono outline-none"
                  aria-label="Daily run time"
                />
              </div>
            </div>
            <CronExpressionInput value={schedule} onChange={setSchedule} timezone={timezone} allowNicknames />
          </div>

          {kind === "system" && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Run as user</Label>
              <Input value={user} onChange={(e) => setUser(e.target.value.trim())} className="h-8 text-xs font-mono" placeholder="root" />
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Command</Label>
            <Textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="font-mono text-xs min-h-[70px]"
              placeholder="/usr/local/bin/backup.sh --quiet"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              Runs with cron's minimal environment (PATH=/usr/bin:/bin). An unescaped <code>%</code> starts the job's stdin — write <code>\%</code> for a literal percent sign, e.g. in <code>date +\%F</code>.
            </p>
            {initial?.heartbeatId !== undefined && mode === "edit" && (
              <p className="text-[11px] text-amber-500">
                This job is monitored (heartbeat #{initial.heartbeatId}); the command includes the heartbeat wrapper.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Label (optional)</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 text-xs" placeholder="Nightly database backup" />
            </div>
            <div className="flex items-center justify-between rounded-md border p-2.5">
              <div>
                <div className="text-xs font-semibold">Enabled</div>
                <div className="text-[11px] text-muted-foreground">Disabled jobs stay in the file as a comment.</div>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-md border p-2.5 cursor-pointer">
            <Checkbox checked={logOutput} onCheckedChange={(v) => setLogOutput(v === true)} className="mt-0.5" />
            <div className="space-y-0.5">
              <div className="text-xs font-semibold">
                Log output to <span className="font-mono">{LOG_DIR}/{logSlug(label)}.log</span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                Appends stdout and stderr instead of mailing them. The directory must already exist and be writable by the job's user, or the job will not start.
              </div>
            </div>
          </label>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-emerald-500" />
              <Label className="text-xs font-semibold">Heartbeat monitoring</Label>
              {initial?.heartbeatId !== undefined && mode === "edit" && (
                <Badge variant="success" className="text-[10px] py-0 px-1.5">
                  #{initial.heartbeatId}
                </Badge>
              )}
            </div>
            <CronMonitorFields
              serverId={serverId}
              entry={
                mode === "edit" && initial
                  ? { lineNo: initial.lineNo, ...(initial.label ? { label: initial.label } : {}), ...(initial.heartbeatId !== undefined ? { heartbeatId: initial.heartbeatId } : {}) }
                  : null
              }
              timezone={timezone}
              value={monitor}
              onChange={setMonitor}
            />
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

          <div className="rounded-md bg-muted/40 border p-2">
            <div className="text-[10px] uppercase text-muted-foreground mb-1">Line preview</div>
            <code className="block text-[11px] font-mono break-all">
              {formatCronEntry({ schedule: schedule.trim(), user, command: finalCommand, disabled: !enabled }, kind)}
            </code>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={touched && errors.length > 0}>
            {mode === "edit" ? "Apply change" : "Add job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
