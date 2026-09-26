import { useEffect, useMemo, useRef, useState } from "react";
import { CRON_NICKNAMES, expandCronNickname, nextCronRuns, validateCronSchedule } from "@inv/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, CalendarClock } from "lucide-react";
import { describeCronSchedule, formatCronRun } from "./cron-describe";

/**
 * Reusable 5-field cron expression editor (minute hour day month weekday) with
 * an optional @nickname mode, a live plain-English description, the next five
 * runs in `timezone`, and the same vixie-compatible validation the API applies.
 * Used by the cron entry dialog, heartbeats and runbook schedules.
 */
export interface CronExpressionInputProps {
  value: string;
  onChange(value: string): void;
  /** IANA zone the next-run preview is shown in (the host's, for crontabs). Defaults to UTC. */
  timezone?: string;
  /** Offer @daily, @reboot, … (default true). */
  allowNicknames?: boolean;
  disabled?: boolean;
}

const FIELDS = [
  { label: "Minute", hint: "0-59" },
  { label: "Hour", hint: "0-23" },
  { label: "Day", hint: "1-31" },
  { label: "Month", hint: "1-12, jan" },
  { label: "Weekday", hint: "0-7, mon" },
] as const;

function toFields(value: string): string[] {
  const s = value.trim();
  const expanded = s.startsWith("@") ? expandCronNickname(s) ?? "0 0 * * *" : s;
  const parts = expanded ? expanded.split(/\s+/) : [];
  return FIELDS.map((_, i) => parts[i] ?? "");
}

export function CronExpressionInput({ value, onChange, timezone = "UTC", allowNicknames = true, disabled }: CronExpressionInputProps) {
  const isNickname = value.trim().startsWith("@");
  const [fields, setFields] = useState<string[]>(() => toFields(value));
  // Only resync the inputs when the value changes from outside, so a field the
  // user has just cleared (which makes the expression briefly invalid) keeps its place.
  const lastEmitted = useRef(value);
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setFields(toFields(value));
    }
  }, [value]);

  const emit = (next: string) => {
    lastEmitted.current = next;
    onChange(next);
  };

  const setField = (i: number, v: string) => {
    const next = fields.map((f, j) => (j === i ? v.replace(/\s+/g, "") : f));
    setFields(next);
    emit(next.join(" "));
  };

  const check = useMemo(() => validateCronSchedule(value), [value]);
  const description = useMemo(() => (check.ok ? describeCronSchedule(value) : null), [check, value]);
  const runs = useMemo(() => (check.ok ? nextCronRuns(value, { timezone, count: 5 }) : []), [check, value, timezone]);

  return (
    <div className="space-y-2">
      {isNickname && allowNicknames ? (
        <div className="flex items-end gap-2">
          <div className="space-y-1 flex-1">
            <Label className="text-[11px] text-muted-foreground">Nickname</Label>
            <Select value={value.trim()} onValueChange={(v) => emit(v)} disabled={disabled}>
              <SelectTrigger className="h-8 text-xs font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(CRON_NICKNAMES).map((n) => (
                  <SelectItem key={n} value={n} className="text-xs font-mono">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={disabled}
            onClick={() => {
              const f = toFields(value);
              setFields(f);
              emit(f.join(" "));
            }}
          >
            Edit fields
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <div className="grid grid-cols-5 gap-1.5 flex-1">
            {FIELDS.map((f, i) => (
              <div key={f.label} className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{f.label}</Label>
                <Input
                  value={fields[i] ?? ""}
                  onChange={(e) => setField(i, e.target.value)}
                  placeholder={f.hint}
                  className="h-8 text-xs font-mono px-2"
                  disabled={disabled}
                  aria-label={`${f.label} (${f.hint})`}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            ))}
          </div>
          {allowNicknames && (
            <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" disabled={disabled} onClick={() => emit("@daily")}>
              @nickname
            </Button>
          )}
        </div>
      )}

      {check.ok ? (
        <div className="rounded-md border bg-muted/30 p-2 space-y-1">
          <div className="text-xs text-foreground">{description ?? value}</div>
          {runs.length > 0 && (
            <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5 mt-px shrink-0" />
              <span>
                Next runs ({timezone}): <span className="font-mono">{runs.map((d) => formatCronRun(d, timezone)).join(" · ")}</span>
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
          <span>{check.error}</span>
        </div>
      )}
    </div>
  );
}
