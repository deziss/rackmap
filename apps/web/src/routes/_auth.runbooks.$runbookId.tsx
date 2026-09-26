import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RUNBOOK_LIMITS,
  RunbookTargetSelector,
  isEmptyRunbookSelector,
  runbookConfigIssues,
  runbookParamNameError,
  type RunbookDto,
} from "@inv/shared";
import { toast } from "sonner";
import { ArrowLeft, Play, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { CronExpressionInput } from "@/components/cron/cron-expression-input";
import { fetchMe, systemKeys } from "@/lib/queries";
import { createRunbook, deleteRunbook, fetchRunbook, runbookKeys, updateRunbook } from "@/lib/runbooks-api";
import { ParamsBuilder, fromEditable, toEditable, type EditableParam } from "@/components/runbooks/params-builder";
import { TargetSelector } from "@/components/runbooks/target-selector";
import { RunDialog } from "@/components/runbooks/run-dialog";

export const Route = createFileRoute("/_auth/runbooks/$runbookId")({
  component: RunbookEditorPage,
});

interface FormState {
  name: string;
  description: string;
  script: string;
  interpreter: "bash" | "sh";
  runAs: "sshUser" | "root";
  timeoutSec: string;
  concurrency: string;
  maxFailures: string;
  requireApproval: boolean;
  allowTargetOverride: boolean;
  targetSelector: RunbookTargetSelector;
  schedule: string;
  scheduleTimezone: string;
  scheduleEnabled: boolean;
  scheduleParams: Record<string, string>;
  params: EditableParam[];
}

const EMPTY_SELECTOR = RunbookTargetSelector.parse({});

function toForm(rb: RunbookDto | undefined): FormState {
  return {
    name: rb?.name ?? "",
    description: rb?.description ?? "",
    script: rb?.script ?? "#!/bin/bash\nset -euo pipefail\n\n# Parameters arrive as environment variables, e.g. \"$VERSION\".\n",
    interpreter: rb?.interpreter ?? "bash",
    runAs: rb?.runAs ?? "sshUser",
    timeoutSec: String(rb?.timeoutSec ?? 300),
    concurrency: String(rb?.concurrency ?? 5),
    maxFailures: rb?.maxFailures ? String(rb.maxFailures) : "",
    requireApproval: rb?.requireApproval ?? false,
    allowTargetOverride: rb?.allowTargetOverride ?? true,
    targetSelector: rb?.targetSelector ?? EMPTY_SELECTOR,
    schedule: rb?.schedule ?? "",
    scheduleTimezone: rb?.scheduleTimezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    scheduleEnabled: rb?.scheduleEnabled ?? false,
    scheduleParams: rb?.scheduleParams ?? {},
    params: toEditable(rb?.parameters ?? []),
  };
}

function Section({ title, children, hint }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-card/60 shadow-xl backdrop-blur-md">
      <div className="border-b border-white/8 px-4 py-3">
        <div className="text-sm font-semibold">{title}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </div>
  );
}

function RunbookEditorPage() {
  const { runbookId } = Route.useParams();
  const isNew = runbookId === "new";
  const id = isNew ? 0 : Number(runbookId);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 5 * 60 * 1000 });
  const canEdit = isNew ? !!me?.can?.["runbook.create"] : !!me?.can?.["runbook.update"];
  const canDelete = !!me?.can?.["runbook.delete"];
  const canExecute = !!me?.can?.["runbook.execute"];

  const runbook = useQuery({ queryKey: runbookKeys.detail(id), queryFn: () => fetchRunbook(id), enabled: !isNew && id > 0 });
  const [form, setForm] = useState<FormState>(() => toForm(undefined));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (runbook.data) setForm(toForm(runbook.data));
  }, [runbook.data]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const issues = useMemo(() => {
    const list: string[] = [];
    if (!form.name.trim()) list.push("Name is required");
    if (!form.script.trim()) list.push("Script is empty");
    if (isEmptyRunbookSelector(form.targetSelector)) list.push("Select at least one server, tag, environment or location");
    const names = form.params.map((p) => p.name.trim());
    for (const p of form.params) {
      const err = p.name.trim() ? runbookParamNameError(p.name.trim()) : "A parameter has no name";
      if (err) list.push(err);
    }
    if (new Set(names).size !== names.length) list.push("Parameter names must be unique");
    for (const i of runbookConfigIssues({
      schedule: form.schedule,
      scheduleTimezone: form.scheduleTimezone,
      scheduleEnabled: form.scheduleEnabled,
      requireApproval: form.requireApproval,
    })) {
      list.push(i.message);
    }
    return list;
  }, [form]);

  const payload = () => {
    const parameters = fromEditable(form.params);
    const known = new Set(parameters.map((p) => p.name));
    return {
      name: form.name.trim(),
      description: form.description.trim() || null,
      script: form.script,
      interpreter: form.interpreter,
      runAs: form.runAs,
      timeoutSec: Number(form.timeoutSec),
      concurrency: Number(form.concurrency),
      maxFailures: form.maxFailures.trim() ? Number(form.maxFailures) : null,
      requireApproval: form.requireApproval,
      allowTargetOverride: form.allowTargetOverride,
      targetSelector: form.targetSelector,
      parameters,
      schedule: form.schedule.trim() || null,
      scheduleTimezone: form.scheduleTimezone.trim() || "UTC",
      scheduleEnabled: form.scheduleEnabled,
      scheduleParams: Object.fromEntries(Object.entries(form.scheduleParams).filter(([k, v]) => known.has(k) && v !== "")),
    };
  };

  const save = useMutation({
    mutationFn: () => (isNew ? createRunbook(payload()) : updateRunbook(id, payload())),
    onSuccess: (rb) => {
      qc.invalidateQueries({ queryKey: runbookKeys.all });
      toast.success(isNew ? "Runbook created" : `Saved (v${rb.version})`);
      if (isNew) void navigate({ to: "/runbooks/$runbookId", params: { runbookId: String(rb.id) } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteRunbook(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: runbookKeys.all });
      toast.success("Runbook deleted");
      void navigate({ to: "/runbooks" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isNew && runbook.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!isNew && runbook.error) return <div className="p-6 text-sm text-destructive">{(runbook.error as Error).message}</div>;

  const scriptBytes = new TextEncoder().encode(form.script).length;
  const readOnly = !canEdit;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/runbooks">
            <ArrowLeft className="h-4 w-4" /> Runbooks
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{isNew ? "New runbook" : form.name || "Runbook"}</h1>
          {runbook.data && (
            <p className="text-xs text-muted-foreground">
              v{runbook.data.version} · updated {new Date(runbook.data.updatedAt).toLocaleString()}
              {runbook.data.updatedBy ? ` by ${runbook.data.updatedBy.name}` : ""}
            </p>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          {!isNew && canExecute && runbook.data && (
            <Button size="sm" variant="outline" onClick={() => setRunning(true)}>
              <Play className="h-4 w-4" /> Run
            </Button>
          )}
          {!isNew && canDelete && (
            <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          {canEdit && (
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || issues.length > 0}>
              <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : isNew ? "Create" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {readOnly && (
        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-muted-foreground">
          Read-only: only admins can edit runbooks.
        </div>
      )}
      {canEdit && issues.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {issues.map((i) => (
            <div key={i}>{i}</div>
          ))}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Section title="Script" hint="Uploaded to each host as a temporary file and run with the interpreter below. Parameters are exported before the first line.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={form.name} disabled={readOnly} maxLength={100} onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Interpreter</Label>
                <Select value={form.interpreter} onValueChange={(v) => set("interpreter", v as "bash" | "sh")} disabled={readOnly}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bash">bash</SelectItem>
                    <SelectItem value="sh">sh</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Input value={form.description} disabled={readOnly} onChange={(e) => set("description", e.target.value)} />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Script</Label>
                <span className={`text-[11px] ${scriptBytes > RUNBOOK_LIMITS.scriptMaxBytes ? "text-destructive" : "text-muted-foreground"}`}>
                  {(scriptBytes / 1024).toFixed(1)} / 64 KB
                </span>
              </div>
              <Textarea
                value={form.script}
                disabled={readOnly}
                spellCheck={false}
                className="min-h-[320px] font-mono text-xs leading-5"
                onChange={(e) => set("script", e.target.value)}
                onKeyDown={(e) => {
                  // Tab inserts two spaces instead of leaving the editor.
                  if (e.key === "Tab" && !e.shiftKey && !readOnly) {
                    e.preventDefault();
                    const t = e.currentTarget;
                    const { selectionStart: s, selectionEnd: en } = t;
                    const next = form.script.slice(0, s) + "  " + form.script.slice(en);
                    set("script", next);
                    requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
                  }
                }}
              />
            </div>
          </Section>

          <Section title="Parameters" hint='Referenced in the script as "$NAME". Values are shell-quoted, never substituted into the script text.'>
            <ParamsBuilder rows={form.params} onChange={(rows) => set("params", rows)} disabled={readOnly} />
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Execution">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Run as</Label>
                <Select value={form.runAs} onValueChange={(v) => set("runAs", v as "sshUser" | "root")} disabled={readOnly}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sshUser">SSH user</SelectItem>
                    <SelectItem value="root">root (sudo)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Timeout (seconds)</Label>
                <Input
                  type="number"
                  min={RUNBOOK_LIMITS.timeoutSecMin}
                  max={RUNBOOK_LIMITS.timeoutSecMax}
                  value={form.timeoutSec}
                  disabled={readOnly}
                  onChange={(e) => set("timeoutSec", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Hosts at a time</Label>
                <Input
                  type="number"
                  min={RUNBOOK_LIMITS.concurrencyMin}
                  max={RUNBOOK_LIMITS.concurrencyMax}
                  value={form.concurrency}
                  disabled={readOnly}
                  onChange={(e) => set("concurrency", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Stop after N failures</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="never"
                  value={form.maxFailures}
                  disabled={readOnly}
                  onChange={(e) => set("maxFailures", e.target.value)}
                />
              </div>
            </div>
            {form.runAs === "root" && (
              <p className="text-xs text-amber-400">Runs from editors as root always wait for an admin's approval.</p>
            )}
            <label className="flex items-start gap-2 text-sm">
              <Switch
                checked={form.requireApproval}
                disabled={readOnly}
                onCheckedChange={(c) => setForm((f) => ({ ...f, requireApproval: c, scheduleEnabled: c ? false : f.scheduleEnabled }))}
              />
              <span>
                Require approval
                <span className="block text-xs text-muted-foreground">Every run, including an admin's, waits for a different admin to approve it.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Switch checked={form.allowTargetOverride} disabled={readOnly} onCheckedChange={(c) => set("allowTargetOverride", c)} />
              <span>
                Allow narrowing targets at run time
                <span className="block text-xs text-muted-foreground">Runners may pick a subset of the targets below, never add to them.</span>
              </span>
            </label>
          </Section>

          <Section title="Targets">
            <TargetSelector value={form.targetSelector} onChange={(v) => set("targetSelector", v)} disabled={readOnly} />
          </Section>

          <Section title="Schedule" hint="Scheduled runs are evaluated by RackMap, not by cron on the hosts.">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.scheduleEnabled}
                disabled={readOnly || form.requireApproval}
                onCheckedChange={(c) => setForm((f) => ({ ...f, scheduleEnabled: c, schedule: c && !f.schedule ? "0 3 * * *" : f.schedule }))}
              />
              Run on a schedule
              {form.requireApproval && <Badge variant="outline">not available with approval</Badge>}
            </label>
            {(form.scheduleEnabled || form.schedule) && !form.requireApproval && (
              <>
                <CronExpressionInput
                  value={form.schedule}
                  onChange={(v) => set("schedule", v)}
                  timezone={form.scheduleTimezone || "UTC"}
                  disabled={readOnly}
                />
                <div className="space-y-1">
                  <Label className="text-xs">Timezone</Label>
                  <Input value={form.scheduleTimezone} disabled={readOnly} onChange={(e) => set("scheduleTimezone", e.target.value)} placeholder="UTC" />
                </div>
                {runbook.data?.nextScheduledAt && form.scheduleEnabled && (
                  <p className="text-xs text-muted-foreground">Next run: {new Date(runbook.data.nextScheduledAt).toLocaleString()}</p>
                )}
                {form.params.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">Values for scheduled runs</div>
                    {form.params
                      .filter((p) => p.name.trim())
                      .map((p) => (
                        <div key={p.key} className="grid grid-cols-[140px_1fr] items-center gap-2">
                          <code className="truncate text-xs">{p.name}</code>
                          <Input
                            className="h-8 font-mono text-xs"
                            type={p.type === "secret" ? "password" : "text"}
                            autoComplete="off"
                            placeholder={p.type === "secret" && form.scheduleParams[p.name] === "***" ? "stored — leave to keep" : p.default || ""}
                            value={form.scheduleParams[p.name] === "***" ? "" : form.scheduleParams[p.name] ?? ""}
                            disabled={readOnly}
                            onChange={(e) =>
                              set("scheduleParams", { ...form.scheduleParams, [p.name]: e.target.value || (p.type === "secret" && runbook.data?.scheduleParams[p.name] === "***" ? "***" : "") })
                            }
                          />
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </Section>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{form.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The runbook stops running and its schedule is removed. Runs that have not started are cancelled; run history is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {runbook.data && <RunDialog runbook={runbook.data} open={running} onOpenChange={setRunning} />}
    </div>
  );
}
