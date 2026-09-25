import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { resolveRunbookParamValues, type RunbookDto, type RunbookParamDef, type RunbookTargetWarning } from "@inv/shared";
import { toast } from "sonner";
import { AlertTriangle, Play, ShieldAlert, FlaskConical } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { previewRunbookTargets, requestRunbookRun, runbookKeys } from "@/lib/runbooks-api";

const WARNING_LABEL: Record<RunbookTargetWarning, string> = {
  down: "down",
  vault_required: "vault locked",
  no_credentials: "no credentials",
};

function initialValues(defs: RunbookParamDef[]): Record<string, string | boolean> {
  const v: Record<string, string | boolean> = {};
  for (const d of defs) {
    if (d.default !== undefined) v[d.name] = d.type === "boolean" ? d.default === true || d.default === "true" : String(d.default);
    else if (d.type === "boolean") v[d.name] = false;
    else v[d.name] = "";
  }
  return v;
}

function ParamField({
  def,
  value,
  error,
  onChange,
}: {
  def: RunbookParamDef;
  value: string | boolean | undefined;
  error?: string;
  onChange(v: string | boolean): void;
}) {
  const label = (
    <Label className="flex items-center gap-2 text-xs">
      <span>{def.label || def.name}</span>
      <code className="text-[10px] text-muted-foreground">{def.name}</code>
      {def.required && <span className="text-destructive">*</span>}
    </Label>
  );
  let control;
  if (def.type === "boolean") {
    control = <Switch checked={value === true} onCheckedChange={(c) => onChange(c)} />;
  } else if (def.type === "enum") {
    control = (
      <Select value={typeof value === "string" && value ? value : undefined} onValueChange={(v) => onChange(v)}>
        <SelectTrigger className="h-8 text-sm">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {(def.enumValues ?? []).map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else {
    control = (
      <Input
        className="h-8 text-sm font-mono"
        type={def.type === "secret" ? "password" : def.type === "number" ? "number" : "text"}
        autoComplete="off"
        value={typeof value === "string" ? value : ""}
        maxLength={def.maxLength}
        placeholder={def.pattern ? `format: ${def.pattern}` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="space-y-1">
      {label}
      {control}
      {def.description && <p className="text-[11px] text-muted-foreground">{def.description}</p>}
      {error && <p className="text-[11px] text-destructive">{def.name} {error}</p>}
    </div>
  );
}

/**
 * Request a run: parameter form generated from the definitions, the resolved
 * target list with warnings (narrowable when the runbook allows it), a dry-run
 * toggle, and a typed "RUN" confirmation for risky runs (root, >10 hosts, or a
 * production host).
 */
export function RunDialog({ runbook, open, onOpenChange }: { runbook: RunbookDto; open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialValues(runbook.parameters));
  const [dryRun, setDryRun] = useState(false);
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(initialValues(runbook.parameters));
      setDryRun(false);
      setSelected(null);
      setConfirmText("");
      setShowErrors(false);
    }
  }, [open, runbook.id, runbook.parameters]);

  const preview = useQuery({
    queryKey: runbookKeys.preview(runbook.id),
    queryFn: () => previewRunbookTargets(runbook.id),
    enabled: open,
    staleTime: 10_000,
  });

  const targets = preview.data?.targets ?? [];
  const chosen = useMemo(() => (selected ? targets.filter((t) => selected.has(t.serverId)) : targets), [selected, targets]);
  const narrowed = selected !== null && chosen.length !== targets.length;

  const { values: resolved, errors } = useMemo(() => {
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (v !== "") input[k] = v;
    return resolveRunbookParamValues(runbook.parameters, input);
  }, [values, runbook.parameters]);
  const paramErrors = dryRun ? {} : errors;

  const needsConfirm =
    !dryRun &&
    (runbook.runAs === "root" || chosen.length > 10 || chosen.some((t) => t.environment?.toLowerCase() === "production"));
  const confirmed = !needsConfirm || confirmText === "RUN";
  const waitsForApproval = !dryRun && (preview.data?.requiresApproval ?? false);

  const run = useMutation({
    mutationFn: () =>
      requestRunbookRun(runbook.id, {
        params: dryRun ? {} : resolved,
        targets: narrowed ? { serverIds: chosen.map((t) => t.serverId) } : undefined,
        dryRun,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: runbookKeys.all });
      qc.invalidateQueries({ queryKey: ["runbook-runs"] });
      toast.success(r.status === "pending_approval" ? "Run requested — waiting for approval" : dryRun ? "Dry run queued" : "Run queued");
      onOpenChange(false);
      void navigate({ to: "/runbooks/runs/$runId", params: { runId: String(r.id) } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (id: number, on: boolean) => {
    const next = new Set(selected ?? targets.map((t) => t.serverId));
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  const submit = () => {
    setShowErrors(true);
    if (Object.keys(paramErrors).length || chosen.length === 0 || !confirmed) return;
    run.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-4 w-4" /> Run “{runbook.name}”
          </DialogTitle>
          <DialogDescription>
            {runbook.runAs === "root" ? "Runs as root (via sudo)" : "Runs as each server's SSH user"} · timeout {runbook.timeoutSec}s ·{" "}
            {runbook.concurrency} host(s) at a time
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <FlaskConical className="h-4 w-4 text-sky-400" />
              <div>
                <div className="font-medium">Dry run</div>
                <div className="text-xs text-muted-foreground">Only checks SSH, the user, bash and passwordless sudo. The script does not run.</div>
              </div>
            </div>
            <Switch checked={dryRun} onCheckedChange={setDryRun} />
          </div>

          {!dryRun && runbook.parameters.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm font-semibold">Parameters</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {runbook.parameters.map((d) => (
                  <ParamField
                    key={d.name}
                    def={d}
                    value={values[d.name]}
                    error={showErrors ? paramErrors[d.name] : undefined}
                    onChange={(v) => setValues((s) => ({ ...s, [d.name]: v }))}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              Targets
              <Badge variant="outline">
                {chosen.length}
                {narrowed ? ` of ${targets.length}` : ""}
              </Badge>
            </div>
            {preview.isLoading && <div className="text-xs text-muted-foreground">Resolving targets…</div>}
            {preview.error && <div className="text-xs text-destructive">{(preview.error as Error).message}</div>}
            {targets.length > 0 && (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/5">
                {targets.map((t) => (
                  <label key={t.serverId} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                    {runbook.allowTargetOverride && (
                      <Checkbox checked={!selected || selected.has(t.serverId)} onCheckedChange={(c) => toggle(t.serverId, c === true)} />
                    )}
                    <span className="font-medium">{t.hostname}</span>
                    <span className="font-mono text-xs text-muted-foreground">{t.ip}</span>
                    {t.environment && <span className="text-xs text-muted-foreground">{t.environment}</span>}
                    <span className="ml-auto flex gap-1">
                      {t.warnings.map((w) => (
                        <Badge key={w} variant={w === "down" ? "warning" : "destructive"} className="text-[10px]">
                          {WARNING_LABEL[w]}
                        </Badge>
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {targets.some((t) => t.warnings.includes("vault_required")) && (
              <p className="text-xs text-amber-400">
                Runs execute in the background, so only a global vault unlock (or VAULT_PASSPHRASE) counts. Hosts marked “vault locked” will fail with
                VAULT_LOCKED.
              </p>
            )}
            {showErrors && chosen.length === 0 && <p className="text-xs text-destructive">Select at least one target.</p>}
          </div>

          {waitsForApproval && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              This run will wait until a different admin approves it
              {runbook.requireApproval ? " (the runbook requires approval)." : " (it runs as root)."}
            </div>
          )}

          {needsConfirm && (
            <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" /> Confirm
              </div>
              <p className="text-xs text-muted-foreground">
                {[
                  runbook.runAs === "root" && "runs as root",
                  chosen.length > 10 && `${chosen.length} hosts`,
                  chosen.some((t) => t.environment?.toLowerCase() === "production") && "includes production hosts",
                ]
                  .filter(Boolean)
                  .join(", ")}
                . Type <code className="font-bold">RUN</code> to continue.
              </p>
              <Input className="h-8 w-32 font-mono" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RUN" />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={run.isPending || preview.isLoading || !!preview.error || !confirmed}
              variant={needsConfirm ? "destructive" : "default"}
            >
              {run.isPending ? "Requesting…" : dryRun ? "Start dry run" : waitsForApproval ? "Request run" : "Run"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
