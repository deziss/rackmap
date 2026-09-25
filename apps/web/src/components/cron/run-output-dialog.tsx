import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CronEntryLine, CronTarget } from "@inv/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Loader2, Play, TerminalSquare } from "lucide-react";
import { runServerCronEntry, cronTargetPath } from "@/lib/cron-api";
import { toast } from "sonner";

interface RunOutputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: number;
  target: CronTarget;
  /** Hash of the saved content the entry was read from (the run is refused if the host changed). */
  baseHash: string;
  entry: CronEntryLine | null;
  /** Called on 409 so the tab can offer a reload. */
  onConflict?: () => void;
}

export function RunOutputDialog({ open, onOpenChange, serverId, target, baseHash, entry, onConflict }: RunOutputDialogProps) {
  const run = useMutation({
    mutationFn: () => runServerCronEntry(serverId, { target, lineNo: entry!.lineNo, baseHash }),
    onError: (err: any) => {
      if (err?.code === "CRON_CONFLICT") {
        onConflict?.();
        onOpenChange(false);
      }
      toast.error(err?.message || "Failed to run the job");
    },
  });

  // Each opening starts from the confirmation step.
  useEffect(() => {
    if (open) run.reset();
  }, [open, entry?.lineNo]); // `run` is stable enough; resetting on its identity would loop

  if (!entry) return null;
  const runAs = target.kind === "user" ? target.user : entry.user ?? "root";
  const result = run.data;

  return (
    <Dialog open={open} onOpenChange={(o) => !run.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[720px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-violet-500/10 text-violet-400">
              <TerminalSquare className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg">Run job now</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Runs line {entry.lineNo} of <span className="font-mono">{cronTargetPath(target)}</span> immediately as{" "}
                <span className="font-mono text-foreground">{runAs}</span>, with cron's environment, a 60 s timeout and 64 KiB of captured output.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md bg-muted/40 border p-2">
            <div className="text-[10px] uppercase text-muted-foreground mb-1">Command</div>
            <code className="block text-[11px] font-mono break-all">{entry.command}</code>
          </div>

          {run.isPending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Running on the host…
            </div>
          )}

          {run.isError && (
            <div className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 mt-px shrink-0" />
              <span>{(run.error as any)?.message || "The run failed"}</span>
            </div>
          )}

          {result && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {result.timedOut ? (
                  <Badge variant="warning">Timed out</Badge>
                ) : result.exitCode === 0 ? (
                  <Badge variant="success">Exit 0</Badge>
                ) : (
                  <Badge variant="destructive">Exit {result.exitCode ?? "?"}</Badge>
                )}
                <span className="text-muted-foreground">{(result.durationMs / 1000).toFixed(1)} s</span>
                {result.truncated && <span className="text-amber-500">Output truncated at 64 KiB</span>}
              </div>
              <OutputBlock title="stdout" text={result.stdout} />
              <OutputBlock title="stderr" text={result.stderr} tone="error" />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            Close
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending} className="gap-1.5">
            <Play className="h-3.5 w-3.5" /> {result || run.isError ? "Run again" : "Run now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OutputBlock({ title, text, tone }: { title: string; text: string; tone?: "error" }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground mb-1">{title}</div>
      <pre
        className={
          "max-h-64 overflow-auto rounded-md border bg-black/40 p-2 text-[11px] font-mono whitespace-pre-wrap break-all " +
          (tone === "error" && text ? "text-rose-300" : "text-foreground")
        }
      >
        {text || <span className="text-muted-foreground">(empty)</span>}
      </pre>
    </div>
  );
}
