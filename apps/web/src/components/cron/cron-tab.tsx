import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CRON_EMPTY_HASH,
  CRON_USERNAME_PATTERN,
  CROND_DELETABLE_PATTERN,
  CROND_FILE_PATTERN,
  cronEnvAt,
  diffCronLines,
  insertCronEntry,
  nextCronRuns,
  parseCrontab,
  removeCronEntry,
  serializeCrontab,
  updateCronEntry,
  validateCrontab,
  type CronDiffOp,
  type CronEntryLine,
  type CronHostSnapshotDto,
  type CronKind,
  type CronLine,
  type CronTarget,
  type CronTargetSnapshotDto,
} from "@inv/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Activity,
  AlertCircle,
  Clock,
  Code,
  Copy,
  Eye,
  List,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Timer,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchMe, systemKeys } from "@/lib/queries";
import {
  cronKeys,
  cronTargetKey,
  cronTargetNeedsSudo,
  cronTargetPath,
  cronTargetTitle,
  fetchServerCron,
  saveServerCron,
} from "@/lib/cron-api";
import type { CronMonitorValue } from "@/components/heartbeats/cron-monitor-fields";
import { CronEntryDialog, type CronEntryDialogMode, type CronEntryDraft } from "./cron-entry-dialog";
import { RunOutputDialog } from "./run-output-dialog";
import { describeCronSchedule, formatCronRun, isValidTimezone } from "./cron-describe";

/**
 * Handed to `onMonitorRequest` after a save, once per entry whose heartbeat
 * monitoring the user switched on or off in the entry dialog. `baseHash` and
 * `lineNo` refer to the content now on the host, ready for the heartbeats
 * module's POST /servers/:id/cron/monitor | unmonitor.
 */
export interface CronMonitorRequest {
  action: "monitor" | "unmonitor";
  target: CronTarget;
  baseHash: string;
  lineNo: number;
  lineText: string;
  label?: string;
  heartbeatId?: number;
  monitor: CronMonitorValue;
}

interface CronTabProps {
  serverId: number;
  /** Heartbeat integration point; without it, monitoring choices are reported as unavailable. */
  onMonitorRequest?: (req: CronMonitorRequest) => Promise<unknown> | void;
}

interface Draft {
  content: string;
  /** Hash / content of the host version this draft started from (the compare-and-set token). */
  baseHash: string;
  baseContent: string;
}

type PendingMonitor = Omit<CronMonitorRequest, "target" | "baseHash" | "lineNo">;

interface SaveVars {
  key: string;
  target: CronTarget;
  content: string;
  baseHash: string;
  deleteFile?: boolean;
  monitors: PendingMonitor[];
}

const TIMERS_KEY = "timers";

function kindOf(t: CronTarget): CronKind {
  return t.kind === "user" ? "user" : "system";
}

function omitKey<T>(obj: Record<string, T>, k: string): Record<string, T> {
  const next = { ...obj };
  delete next[k];
  return next;
}

function entriesOf(lines: CronLine[]): CronEntryLine[] {
  return lines.filter((l): l is CronEntryLine => l.type === "entry");
}

export function CronTab({ serverId, onMonitorRequest }: CronTabProps) {
  const queryClient = useQueryClient();
  const { data: me, isLoading: meLoading } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe });
  const canCron = me?.can?.["server.cron"] === true;
  const canSudo = me?.can?.["server.sudo"] === true;

  const snapshotQuery = useQuery({
    queryKey: cronKeys.snapshot(serverId),
    queryFn: () => fetchServerCron(serverId),
    enabled: canCron,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const snapshot = snapshotQuery.data;
  const hostTz = snapshot?.timezone ?? "UTC";

  const [extraTargets, setExtraTargets] = useState<CronTargetSnapshotDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState<Record<string, PendingMonitor[]>>({});
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"table" | "raw">("table");
  const [showDiff, setShowDiff] = useState(false);
  const [entryDialog, setEntryDialog] = useState<{ mode: CronEntryDialogMode; initial: CronEntryLine | null } | null>(null);
  const [runEntry, setRunEntry] = useState<CronEntryLine | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<CronEntryLine | null>(null);
  const [newTargetKind, setNewTargetKind] = useState<"user" | "crond" | null>(null);
  const [deleteFileOpen, setDeleteFileOpen] = useState(false);

  const targets = useMemo(() => {
    const list = [...(snapshot?.targets ?? [])];
    for (const x of extraTargets) {
      if (!list.some((t) => cronTargetKey(t.target) === cronTargetKey(x.target))) list.push(x);
    }
    return list;
  }, [snapshot, extraTargets]);

  const selectedKey = selected ?? (targets[0] ? cronTargetKey(targets[0].target) : TIMERS_KEY);
  const current = targets.find((t) => cronTargetKey(t.target) === selectedKey) ?? null;
  const key = current ? cronTargetKey(current.target) : "";
  const kind: CronKind = current ? kindOf(current.target) : "user";
  const draft = drafts[key];
  const dirty = !!current && !!draft && draft.content !== draft.baseContent;
  const text = dirty ? draft!.content : current?.content ?? "";

  const lines = useMemo(() => parseCrontab(text, kind), [text, kind]);
  const entries = useMemo(() => entriesOf(lines), [lines]);
  const problems = useMemo(() => validateCrontab(text, kind), [text, kind]);
  const envLines = useMemo(() => lines.filter((l) => l.type === "env"), [lines]);
  const diffOps = useMemo(() => (dirty ? diffCronLines(draft!.baseContent, text) : []), [dirty, draft, text]);

  const locked = !!current && cronTargetNeedsSudo(current) && !canSudo;
  const readOnly = !!current?.readOnly;
  const editable = !!current && canCron && !locked && !readOnly;

  const dirtyKeys = useMemo(
    () => new Set(Object.entries(drafts).filter(([, d]) => d.content !== d.baseContent).map(([k]) => k)),
    [drafts],
  );
  const entryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of targets) m.set(cronTargetKey(t.target), entriesOf(parseCrontab(t.content, kindOf(t.target))).length);
    return m;
  }, [targets]);

  function setText(next: string) {
    if (!current) return;
    setDrafts((d) => {
      const prev = d[key];
      const base =
        prev && prev.content !== prev.baseContent
          ? prev
          : { content: current.content, baseHash: current.hash, baseContent: current.content };
      return { ...d, [key]: { ...base, content: next } };
    });
  }

  function discard(k: string) {
    setDrafts((d) => omitKey(d, k));
    setPending((p) => omitKey(p, k));
    setConflicts((c) => omitKey(c, k));
  }

  // A job appended at the end runs under the last CRON_TZ in the file, if any.
  const lastCronTz = cronEnvAt(lines, Number.MAX_SAFE_INTEGER)["CRON_TZ"];
  const newEntryTimezone = isValidTimezone(lastCronTz) ? lastCronTz : hostTz;

  function entryTimezone(e: CronEntryLine): string {
    const tz = cronEnvAt(lines, e.lineNo)["CRON_TZ"];
    return isValidTimezone(tz) ? tz : hostTz;
  }

  // -------------------------------------------------------------------------
  // Save / delete
  // -------------------------------------------------------------------------

  const saveMutation = useMutation({
    mutationFn: (v: SaveVars) =>
      saveServerCron(serverId, {
        target: v.target,
        content: v.content,
        baseHash: v.baseHash,
        ...(v.deleteFile ? { deleteFile: true } : {}),
      }),
    onSuccess: async (res, v) => {
      toast.success(v.deleteFile ? `Deleted ${cronTargetPath(v.target)}` : `Saved ${cronTargetPath(v.target)} on the host`);
      queryClient.setQueryData<CronHostSnapshotDto>(cronKeys.snapshot(serverId), (old) => {
        if (!old) return old;
        const others = old.targets.filter((t) => cronTargetKey(t.target) !== v.key);
        if (v.deleteFile) return { ...old, targets: others };
        const prev = targets.find((t) => cronTargetKey(t.target) === v.key);
        const updated: CronTargetSnapshotDto = {
          ...(prev ?? { target: v.target, privileged: false }),
          content: v.content,
          hash: res.hash,
          exists: true,
        };
        const idx = old.targets.findIndex((t) => cronTargetKey(t.target) === v.key);
        const list = [...old.targets];
        if (idx >= 0) list[idx] = updated;
        else list.push(updated);
        return { ...old, targets: list };
      });
      setExtraTargets((x) => x.filter((t) => cronTargetKey(t.target) !== v.key));
      discard(v.key);
      if (v.deleteFile) setSelected(null);

      if (v.monitors.length > 0) {
        if (!onMonitorRequest) {
          toast.info("Heartbeat monitoring is not available here yet; the job was saved without it.");
        } else {
          for (const p of v.monitors) {
            try {
              // Each monitor call rewrites the file, so re-read the hash and line number every time.
              const fresh = await queryClient.fetchQuery({
                queryKey: cronKeys.snapshot(serverId),
                queryFn: () => fetchServerCron(serverId),
                staleTime: 0,
              });
              const t = fresh.targets.find((x) => cronTargetKey(x.target) === v.key);
              const e = t ? entriesOf(parseCrontab(t.content, kindOf(v.target))).find((x) => x.raw === p.lineText) : undefined;
              if (!t || !e) continue;
              await onMonitorRequest({ ...p, target: v.target, baseHash: t.hash, lineNo: e.lineNo });
            } catch (err: any) {
              toast.error(`Could not ${p.action === "monitor" ? "enable" : "disable"} monitoring: ${err?.message ?? err}`);
            }
          }
        }
      }
      await queryClient.invalidateQueries({ queryKey: cronKeys.snapshot(serverId) });
    },
    onError: (err: any, v) => {
      if (err?.code === "CRON_CONFLICT") {
        setConflicts((c) => ({ ...c, [v.key]: true }));
        return;
      }
      toast.error(err?.message || "Failed to save the crontab");
    },
  });

  function save() {
    if (!current) return;
    let content = text;
    if (content !== "" && !content.endsWith("\n")) content += "\n";
    saveMutation.mutate({
      key,
      target: current.target,
      content,
      baseHash: draft?.baseHash ?? current.hash,
      monitors: pending[key] ?? [],
    });
  }

  async function reloadAfterConflict() {
    discard(key);
    await snapshotQuery.refetch();
  }

  // -------------------------------------------------------------------------
  // Entry edits (staged in the draft)
  // -------------------------------------------------------------------------

  function handleEntrySave(d: CronEntryDraft, monitor: CronMonitorValue) {
    const dlg = entryDialog;
    if (!dlg) return;
    const fields = {
      schedule: d.schedule,
      command: d.command,
      disabled: d.disabled,
      ...(kind === "system" ? { user: d.user ?? "root" } : {}),
    };
    let next: CronLine[];
    let ordinal: number;
    if (dlg.mode === "edit" && dlg.initial) {
      next = updateCronEntry(lines, dlg.initial.lineNo, { ...fields, label: d.label });
      ordinal = entries.findIndex((e) => e.lineNo === dlg.initial!.lineNo);
    } else {
      const after = dlg.mode === "duplicate" ? dlg.initial?.lineNo : undefined;
      next = insertCronEntry(lines, { ...fields, ...(d.label ? { label: d.label } : {}) }, after);
      ordinal = after === undefined ? entries.length : entries.findIndex((e) => e.lineNo === after) + 1;
    }
    const nextText = serializeCrontab(next);
    setText(nextText);

    const saved = entriesOf(parseCrontab(nextText, kind))[ordinal];
    const hadHb = dlg.mode === "edit" ? dlg.initial?.heartbeatId : undefined;
    const action = monitor.enabled && hadHb === undefined ? "monitor" : !monitor.enabled && hadHb !== undefined ? "unmonitor" : null;
    setPending((p) => {
      const list = (p[key] ?? []).filter((x) => x.lineText !== dlg.initial?.raw || dlg.mode !== "edit");
      if (action && saved) {
        list.push({
          action,
          lineText: saved.raw,
          monitor,
          ...(d.label ? { label: d.label } : {}),
          ...(hadHb !== undefined ? { heartbeatId: hadHb } : {}),
        });
      }
      return { ...p, [key]: list };
    });
    if (dlg.mode === "duplicate" && dlg.initial?.heartbeatId !== undefined) {
      toast.info("The copy is not monitored, but its command still contains the original heartbeat wrapper — edit it before saving.");
    }
  }

  function toggleEntry(e: CronEntryLine, enabled: boolean) {
    setText(serializeCrontab(updateCronEntry(lines, e.lineNo, { disabled: !enabled })));
  }

  function removeEntry(e: CronEntryLine) {
    setText(serializeCrontab(removeCronEntry(lines, e.lineNo)));
    setPending((p) => ({ ...p, [key]: (p[key] ?? []).filter((x) => x.lineText !== e.raw) }));
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (meLoading) {
    return <CenteredNote icon={<Loader2 className="h-5 w-5 animate-spin" />} text="Loading permissions…" />;
  }
  if (!canCron) {
    return (
      <CenteredNote
        icon={<Lock className="h-5 w-5" />}
        text="Viewing and editing cron jobs requires the server:cron permission (editors and admins)."
      />
    );
  }

  const userTargets = targets.filter((t) => t.target.kind === "user");
  const systemTargets = targets.filter((t) => t.target.kind === "system");
  const crondTargets = targets.filter((t) => t.target.kind === "crond");
  const pendingCount = (pending[key] ?? []).length;
  const canDeleteFile =
    !!current &&
    current.target.kind === "crond" &&
    CROND_DELETABLE_PATTERN.test(current.target.file) &&
    current.exists !== false &&
    editable &&
    !dirty;

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="p-4 rounded-xl border bg-card/70 backdrop-blur space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Cron Jobs & Scheduled Tasks</h3>
              <p className="text-xs text-muted-foreground">
                Edit user crontabs, /etc/crontab and /etc/cron.d with validation, conflict detection and a backup of every
                previous version under /var/backups/rackmap-cron on the host.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {snapshot && (
              <Badge variant="outline" className="text-[10px] font-mono gap-1">
                <Clock className="h-3 w-3" /> Host time zone: {snapshot.timezone}
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5"
              onClick={() => snapshotQuery.refetch()}
              disabled={snapshotQuery.isFetching}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", snapshotQuery.isFetching && "animate-spin")} /> Reload from host
            </Button>
          </div>
        </div>
        {snapshot?.warnings?.map((w) => (
          <div key={w} className="flex items-start gap-1.5 text-[11px] text-amber-500">
            <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" /> <span>{w}</span>
          </div>
        ))}
      </div>

      {snapshotQuery.isLoading ? (
        <CenteredNote
          icon={<Loader2 className="h-5 w-5 animate-spin" />}
          text="Reading crontabs, /etc/cron.d and systemd timers over SSH…"
        />
      ) : snapshotQuery.isError ? (
        <div className="py-10 text-center text-destructive text-xs space-y-2 rounded-xl border">
          <AlertCircle className="h-5 w-5 mx-auto" />
          <div>{(snapshotQuery.error as any)?.message || "Failed to read cron configuration"}</div>
          {(snapshotQuery.error as any)?.code === "VAULT_LOCKED" && (
            <div className="text-muted-foreground">Unlock the credential vault, then reload.</div>
          )}
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => snapshotQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
          {/* Target selector */}
          <Card className="h-fit">
            <CardContent className="p-2 space-y-3">
              <TargetGroup
                title="User crontabs"
                action={
                  <button
                    type="button"
                    className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
                    onClick={() => setNewTargetKind("user")}
                  >
                    <Plus className="h-3 w-3" /> New
                  </button>
                }
              >
                {userTargets.length === 0 && <div className="px-2 py-1 text-[11px] text-muted-foreground">No user crontabs</div>}
                {userTargets.map((t) => (
                  <TargetItem
                    key={cronTargetKey(t.target)}
                    snap={t}
                    active={selectedKey === cronTargetKey(t.target)}
                    count={entryCounts.get(cronTargetKey(t.target)) ?? 0}
                    dirty={dirtyKeys.has(cronTargetKey(t.target))}
                    locked={cronTargetNeedsSudo(t) && !canSudo}
                    onSelect={() => setSelected(cronTargetKey(t.target))}
                  />
                ))}
              </TargetGroup>
              <TargetGroup title="System">
                {systemTargets.map((t) => (
                  <TargetItem
                    key="system"
                    snap={t}
                    active={selectedKey === "system"}
                    count={entryCounts.get("system") ?? 0}
                    dirty={dirtyKeys.has("system")}
                    locked={!canSudo}
                    onSelect={() => setSelected("system")}
                  />
                ))}
              </TargetGroup>
              <TargetGroup
                title="/etc/cron.d"
                action={
                  canSudo ? (
                    <button
                      type="button"
                      className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
                      onClick={() => setNewTargetKind("crond")}
                    >
                      <Plus className="h-3 w-3" /> New file
                    </button>
                  ) : undefined
                }
              >
                {crondTargets.length === 0 && <div className="px-2 py-1 text-[11px] text-muted-foreground">No files</div>}
                {crondTargets.map((t) => (
                  <TargetItem
                    key={cronTargetKey(t.target)}
                    snap={t}
                    active={selectedKey === cronTargetKey(t.target)}
                    count={entryCounts.get(cronTargetKey(t.target)) ?? 0}
                    dirty={dirtyKeys.has(cronTargetKey(t.target))}
                    locked={!canSudo}
                    onSelect={() => setSelected(cronTargetKey(t.target))}
                  />
                ))}
              </TargetGroup>
              <TargetGroup title="systemd">
                <button
                  type="button"
                  onClick={() => setSelected(TIMERS_KEY)}
                  className={cn(
                    "w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                    selectedKey === TIMERS_KEY ? "bg-secondary" : "hover:bg-white/5",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <Timer className="h-3.5 w-3.5 text-muted-foreground" /> Timers
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Eye className="h-3 w-3" /> {snapshot?.timers.length ?? 0}
                  </span>
                </button>
              </TargetGroup>
            </CardContent>
          </Card>

          {/* Selected target */}
          <div className="space-y-3 min-w-0">
            {selectedKey === TIMERS_KEY || !current ? (
              <TimersPanel timers={snapshot?.timers ?? []} />
            ) : (
              <Card>
                <CardHeader className="p-4 pb-2 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <CardTitle className="text-sm font-mono truncate">{cronTargetPath(current.target)}</CardTitle>
                      {current.exists === false && (
                        <Badge variant="outline" className="text-[10px] py-0">
                          new
                        </Badge>
                      )}
                      {current.target.kind === "user" && current.privileged && (
                        <Badge variant="warning" className="text-[10px] py-0 gap-1">
                          <ShieldAlert className="h-3 w-3" /> root-equivalent ({current.privilegeReason ?? "privileged"})
                        </Badge>
                      )}
                      {readOnly && (
                        <Badge variant="secondary" className="text-[10px] py-0 gap-1">
                          <Eye className="h-3 w-3" /> read-only
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="flex rounded-md border p-0.5">
                        <Button
                          size="sm"
                          variant={mode === "table" ? "secondary" : "ghost"}
                          className="h-7 text-[11px] gap-1 px-2"
                          onClick={() => setMode("table")}
                        >
                          <List className="h-3 w-3" /> Jobs
                        </Button>
                        <Button
                          size="sm"
                          variant={mode === "raw" ? "secondary" : "ghost"}
                          className="h-7 text-[11px] gap-1 px-2"
                          onClick={() => setMode("raw")}
                        >
                          <Code className="h-3 w-3" /> Raw
                        </Button>
                      </div>
                      {canDeleteFile && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs gap-1 text-destructive hover:text-destructive"
                          onClick={() => setDeleteFileOpen(true)}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete file
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="h-8 text-xs gap-1.5"
                        disabled={!editable}
                        onClick={() => setEntryDialog({ mode: "add", initial: null })}
                      >
                        <Plus className="h-3.5 w-3.5" /> Add job
                      </Button>
                    </div>
                  </div>

                  {locked && (
                    <Banner tone="muted" icon={<Lock className="h-3.5 w-3.5" />}>
                      {current.target.kind === "user" && current.target.user !== "root"
                        ? `${current.target.user} is root-equivalent on this host (${current.privilegeReason ?? "privileged"}), so its crontab`
                        : "This crontab runs jobs as root and"}{" "}
                      can only be changed by users with the <span className="font-mono">server:sudo</span> permission (admins).
                    </Banner>
                  )}
                  {readOnly && current.warning && (
                    <Banner tone="muted" icon={<Eye className="h-3.5 w-3.5" />}>
                      {current.warning}
                    </Banner>
                  )}
                  {conflicts[key] && (
                    <Banner tone="danger" icon={<AlertCircle className="h-3.5 w-3.5" />}>
                      <div className="flex items-center justify-between gap-2 flex-wrap w-full">
                        <span>This crontab changed on the host since you loaded it. Reload to get the current version — your unsaved edits will be discarded.</span>
                        <span className="flex gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px] gap-1"
                            onClick={() => {
                              navigator.clipboard?.writeText(text).then(
                                () => toast.success("Your version was copied to the clipboard"),
                                () => toast.error("Could not copy to the clipboard"),
                              );
                            }}
                          >
                            <Copy className="h-3 w-3" /> Copy my version
                          </Button>
                          <Button size="sm" className="h-7 text-[11px] gap-1" onClick={reloadAfterConflict}>
                            <RotateCcw className="h-3 w-3" /> Reload
                          </Button>
                        </span>
                      </div>
                    </Banner>
                  )}
                  {problems.length > 0 && (
                    <Banner tone="danger" icon={<AlertCircle className="h-3.5 w-3.5" />}>
                      <div className="space-y-0.5">
                        {problems.slice(0, 6).map((p) => (
                          <div key={p.lineNo}>
                            Line {p.lineNo}: {p.error}
                          </div>
                        ))}
                        {problems.length > 6 && <div>…and {problems.length - 6} more</div>}
                      </div>
                    </Banner>
                  )}
                  {envLines.length > 0 && mode === "table" && (
                    <div className="flex flex-wrap gap-1.5">
                      {envLines.map((l) =>
                        l.type === "env" ? (
                          <span key={l.lineNo} className="rounded border bg-muted/40 px-1.5 py-0.5 text-[10px] font-mono" title={`line ${l.lineNo}`}>
                            {l.name}={l.value === "" ? '""' : l.value}
                          </span>
                        ) : null,
                      )}
                    </div>
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  {mode === "raw" ? (
                    <div className="p-4 pt-2 space-y-1.5">
                      <Textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        readOnly={!editable}
                        spellCheck={false}
                        className="font-mono text-xs min-h-[380px] leading-5"
                        placeholder={kind === "system" ? "# m h dom mon dow user command" : "# m h dom mon dow command"}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {kind === "system"
                          ? "System format: five time fields, the user, then the command."
                          : "User format: five time fields, then the command."}{" "}
                        Disabled jobs are kept as <span className="font-mono">#rackmap:disabled …</span>; labels are{" "}
                        <span className="font-mono"># rackmap: &lt;label&gt;</span> comments directly above a job.
                      </p>
                    </div>
                  ) : entries.length === 0 ? (
                    <div className="py-12 text-center text-muted-foreground text-xs">
                      No jobs in this crontab yet.{editable ? " Use “Add job” to create one." : ""}
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b bg-muted/40 text-muted-foreground text-[10px]">
                            <th className="py-2.5 px-3 text-left font-medium w-12">On</th>
                            <th className="py-2.5 px-3 text-left font-medium">Schedule</th>
                            <th className="py-2.5 px-3 text-left font-medium">Next runs</th>
                            {kind === "system" && <th className="py-2.5 px-3 text-left font-medium">User</th>}
                            <th className="py-2.5 px-3 text-left font-medium">Command</th>
                            <th className="py-2.5 px-3 text-left font-medium">Label</th>
                            <th className="py-2.5 px-3 text-right font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/30">
                          {entries.map((e) => (
                            <EntryRow
                              key={`${e.lineNo}:${e.raw}`}
                              entry={e}
                              kind={kind}
                              timezone={entryTimezone(e)}
                              editable={editable}
                              canRun={editable && !dirty && current.exists !== false}
                              runBlockedReason={dirty ? "Save or discard your changes first" : undefined}
                              onToggle={(on) => toggleEntry(e, on)}
                              onEdit={() => setEntryDialog({ mode: "edit", initial: e })}
                              onDuplicate={() => setEntryDialog({ mode: "duplicate", initial: e })}
                              onDelete={() => setDeleteEntry(e)}
                              onRun={() => setRunEntry(e)}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Sticky save bar */}
            {current && dirty && (
              <div className="sticky bottom-2 z-10 rounded-xl border bg-card/95 backdrop-blur p-3 shadow-lg space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-xs">
                    Unsaved changes to <span className="font-mono">{cronTargetPath(current.target)}</span>:{" "}
                    <span className="text-emerald-400 font-mono">+{diffOps.filter((o) => o.op === "add").length}</span>{" "}
                    <span className="text-rose-400 font-mono">−{diffOps.filter((o) => o.op === "del").length}</span> lines
                    {pendingCount > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        · <Activity className="inline h-3 w-3" /> {pendingCount} monitoring change{pendingCount > 1 ? "s" : ""} after save
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setShowDiff((s) => !s)}>
                      {showDiff ? "Hide diff" : "Show diff"}
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => discard(key)} disabled={saveMutation.isPending}>
                      Discard
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 text-xs gap-1.5"
                      onClick={save}
                      disabled={!editable || problems.length > 0 || saveMutation.isPending || !!conflicts[key]}
                    >
                      {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save to host
                    </Button>
                  </div>
                </div>
                {problems.length > 0 && (
                  <div className="text-[11px] text-destructive">
                    Fix {problems.length} invalid line{problems.length > 1 ? "s" : ""} before saving.
                  </div>
                )}
                {showDiff && <DiffPreview ops={diffOps} />}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dialogs */}
      {current && (
        <CronEntryDialog
          open={entryDialog !== null}
          onOpenChange={(o) => !o && setEntryDialog(null)}
          serverId={serverId}
          kind={kind}
          timezone={entryDialog?.initial ? entryTimezone(entryDialog.initial) : newEntryTimezone}
          mode={entryDialog?.mode ?? "add"}
          initial={entryDialog?.initial ?? null}
          onSave={handleEntrySave}
        />
      )}

      {current && (
        <RunOutputDialog
          open={runEntry !== null}
          onOpenChange={(o) => !o && setRunEntry(null)}
          serverId={serverId}
          target={current.target}
          baseHash={current.hash}
          entry={runEntry}
          onConflict={() => setConflicts((c) => ({ ...c, [key]: true }))}
        />
      )}

      <AlertDialog open={deleteEntry !== null} onOpenChange={(o) => !o && setDeleteEntry(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this job?</AlertDialogTitle>
            <AlertDialogDescription>
              The line is removed from the editor; the host is only changed when you save.
              {deleteEntry?.heartbeatId !== undefined && " Its heartbeat monitor is not deleted automatically."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteEntry && <code className="block rounded-md border bg-muted/40 p-2 text-[11px] font-mono break-all">{deleteEntry.raw}</code>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteEntry) removeEntry(deleteEntry);
                setDeleteEntry(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteFileOpen} onOpenChange={setDeleteFileOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {current ? cronTargetPath(current.target) : "file"}?</AlertDialogTitle>
            <AlertDialogDescription>
              The file is removed from the host now; a backup is kept under /var/backups/rackmap-cron.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (current) {
                  saveMutation.mutate({ key, target: current.target, content: "", baseHash: current.hash, deleteFile: true, monitors: [] });
                }
                setDeleteFileOpen(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <NewTargetDialog
        kind={newTargetKind}
        onOpenChange={(o) => !o && setNewTargetKind(null)}
        onCreate={(target) => {
          const k = cronTargetKey(target);
          if (!targets.some((t) => cronTargetKey(t.target) === k)) {
            setExtraTargets((x) => [
              ...x,
              { target, content: "", hash: CRON_EMPTY_HASH, privileged: false, exists: false, path: cronTargetPath(target) },
            ]);
          }
          setSelected(k);
          setNewTargetKind(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function CenteredNote({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground text-xs rounded-xl border">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: "muted" | "danger"; icon: ReactNode; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded-md border p-2 text-[11px]",
        tone === "danger" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-white/10 bg-muted/40 text-muted-foreground",
      )}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function TargetGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between px-2 pt-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function TargetItem({
  snap,
  active,
  count,
  dirty,
  locked,
  onSelect,
}: {
  snap: CronTargetSnapshotDto;
  active: boolean;
  count: number;
  dirty: boolean;
  locked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs",
        active ? "bg-secondary" : "hover:bg-white/5",
      )}
      title={snap.warning ?? snap.path ?? cronTargetPath(snap.target)}
    >
      <span className={cn("truncate font-mono", snap.readOnly && "text-muted-foreground")}>{cronTargetTitle(snap.target)}</span>
      <span className="flex items-center gap-1 shrink-0">
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
        {snap.target.kind === "user" && snap.privileged && snap.target.user !== "root" && (
          <ShieldAlert className="h-3 w-3 text-amber-500" aria-label={`root-equivalent (${snap.privilegeReason ?? "privileged"})`} />
        )}
        {locked && <Lock className="h-3 w-3 text-muted-foreground" aria-label="requires server:sudo" />}
        {snap.readOnly && <Eye className="h-3 w-3 text-muted-foreground" aria-label="read-only" />}
        <span className="text-[10px] text-muted-foreground font-mono">{snap.exists === false ? "new" : count}</span>
      </span>
    </button>
  );
}

function EntryRow({
  entry,
  kind,
  timezone,
  editable,
  canRun,
  runBlockedReason,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
  onRun,
}: {
  entry: CronEntryLine;
  kind: CronKind;
  timezone: string;
  editable: boolean;
  canRun: boolean;
  runBlockedReason?: string;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRun: () => void;
}) {
  const description = useMemo(() => describeCronSchedule(entry.schedule), [entry.schedule]);
  const runs = useMemo(() => nextCronRuns(entry.schedule, { timezone, count: 3 }), [entry.schedule, timezone]);
  return (
    <tr className={cn("hover:bg-muted/30 align-top", entry.disabled && "opacity-60")}>
      <td className="py-2.5 px-3">
        <Switch
          checked={!entry.disabled}
          onCheckedChange={onToggle}
          disabled={!editable}
          aria-label={entry.disabled ? "Enable job" : "Disable job"}
        />
      </td>
      <td className="py-2.5 px-3">
        <div className="font-mono text-[11px] text-foreground">{entry.schedule}</div>
        <div className="text-[10px] text-muted-foreground max-w-[220px]">{description ?? "—"}</div>
      </td>
      <td className="py-2.5 px-3 text-[10px] text-muted-foreground font-mono whitespace-nowrap">
        {entry.schedule === "@reboot" ? (
          <span>at boot</span>
        ) : runs.length ? (
          runs.map((d) => <div key={d.getTime()}>{formatCronRun(d, timezone)}</div>)
        ) : (
          "—"
        )}
      </td>
      {kind === "system" && <td className="py-2.5 px-3 font-mono text-[11px]">{entry.user}</td>}
      <td className="py-2.5 px-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-[360px] truncate font-mono text-[11px]">{entry.command}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[600px] break-all font-mono text-[11px]">{entry.command}</TooltipContent>
        </Tooltip>
      </td>
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {entry.label && <span className="text-[11px]">{entry.label}</span>}
          {entry.heartbeatId !== undefined && (
            <Badge variant="success" className="text-[9px] py-0 px-1.5 gap-1" title={`Heartbeat #${entry.heartbeatId}`}>
              <Activity className="h-2.5 w-2.5" /> monitored
            </Badge>
          )}
          {!entry.label && entry.heartbeatId === undefined && <span className="text-muted-foreground/60">—</span>}
        </div>
      </td>
      <td className="py-2.5 px-3 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Job actions">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onEdit} disabled={!editable} className="text-xs gap-2">
              <Pencil className="h-3.5 w-3.5" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate} disabled={!editable} className="text-xs gap-2">
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRun} disabled={!canRun} className="text-xs gap-2" title={runBlockedReason}>
              <Play className="h-3.5 w-3.5" /> Run now{runBlockedReason ? " (save first)" : ""}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} disabled={!editable} className="text-xs gap-2 text-destructive focus:text-destructive">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

function DiffPreview({ ops }: { ops: CronDiffOp[] }) {
  // Changed lines plus one line of context on each side.
  const keep = ops.map((o, i) => o.op !== "same" || (ops[i - 1] !== undefined && ops[i - 1]!.op !== "same") || (ops[i + 1] !== undefined && ops[i + 1]!.op !== "same"));
  const rows: { op: CronDiffOp["op"] | "gap"; text: string }[] = [];
  ops.forEach((o, i) => {
    if (keep[i]) rows.push(o);
    else if (rows[rows.length - 1]?.op !== "gap") rows.push({ op: "gap", text: "…" });
  });
  return (
    <pre className="max-h-72 overflow-auto rounded-md border bg-black/40 p-2 text-[11px] font-mono leading-5">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre-wrap break-all",
            r.op === "add" && "bg-emerald-500/10 text-emerald-300",
            r.op === "del" && "bg-rose-500/10 text-rose-300",
            (r.op === "same" || r.op === "gap") && "text-muted-foreground",
          )}
        >
          {r.op === "add" ? "+ " : r.op === "del" ? "- " : "  "}
          {r.text}
        </div>
      ))}
    </pre>
  );
}

function TimersPanel({ timers }: { timers: CronHostSnapshotDto["timers"] }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Timer className="h-4 w-4 text-muted-foreground" /> systemd timers
          <Badge variant="secondary" className="text-[10px] py-0 gap-1">
            <Eye className="h-3 w-3" /> read-only
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {timers.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground text-xs">No systemd timers reported (or systemd is not running on this host).</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/40 text-muted-foreground text-[10px]">
                  <th className="py-2.5 px-3 text-left font-medium">Timer</th>
                  <th className="py-2.5 px-3 text-left font-medium">Activates</th>
                  <th className="py-2.5 px-3 text-left font-medium">Next</th>
                  <th className="py-2.5 px-3 text-left font-medium">Last</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30 font-mono text-[11px]">
                {timers.map((t) => (
                  <tr key={t.unit} className="hover:bg-muted/30">
                    <td className="py-2 px-3">{t.unit}</td>
                    <td className="py-2 px-3 text-muted-foreground">{t.activates}</td>
                    <td className="py-2 px-3">{t.next ?? "—"}</td>
                    <td className="py-2 px-3 text-muted-foreground">{t.last ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NewTargetDialog({
  kind,
  onOpenChange,
  onCreate,
}: {
  kind: "user" | "crond" | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (target: CronTarget) => void;
}) {
  const [name, setName] = useState("");
  const open = kind !== null;
  const value = name || (kind === "crond" ? "rackmap-" : "");
  const valid =
    kind === "user"
      ? value.length > 0 && value.length <= 32 && CRON_USERNAME_PATTERN.test(value)
      : CROND_FILE_PATTERN.test(value) && value !== "rackmap-";
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setName("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-base">{kind === "crond" ? "New /etc/cron.d file" : "Crontab for another user"}</DialogTitle>
          <DialogDescription className="text-xs">
            {kind === "crond"
              ? "Letters, digits, '_' and '-' only (cron ignores other names). Files named rackmap-* can later be deleted from here."
              : "Opens an empty crontab for an existing Linux user; it is created on the host when you save."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label className="text-xs">{kind === "crond" ? "File name" : "Username"}</Label>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setName(e.target.value.trim())}
            className="h-8 text-xs font-mono"
            placeholder={kind === "crond" ? "rackmap-backups" : "www-data"}
          />
          {value && !valid && <p className="text-[11px] text-destructive">Not a valid {kind === "crond" ? "file name" : "username"}.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onCreate(kind === "crond" ? { kind: "crond", file: value } : { kind: "user", user: value });
              setName("");
            }}
          >
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
