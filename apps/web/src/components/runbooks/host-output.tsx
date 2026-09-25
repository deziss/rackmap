import { useEffect, useRef, useState } from "react";
import { fetchRunbookHostOutput, stripAnsi } from "@/lib/runbooks-api";

/**
 * Output for one host, fetched incrementally by character offset and polled
 * every 1.5s until the host finishes. Offsets come from the server so a chunk is
 * never fetched twice; when a response is a full chunk the next one is fetched
 * right away rather than waiting for the poll.
 */
export function HostOutput({ runId, serverId, live }: { runId: number; serverId: number; live: boolean }) {
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [truncated, setTruncated] = useState({ stdout: false, stderr: false });
  const [error, setError] = useState<string | null>(null);
  const offsets = useRef({ stdoutFrom: 0, stderrFrom: 0 });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    offsets.current = { stdoutFrom: 0, stderrFrom: 0 };
    setStdout("");
    setStderr("");

    const poll = async () => {
      try {
        const res = await fetchRunbookHostOutput(runId, serverId, offsets.current);
        if (cancelled) return;
        if (res.stdout) setStdout((s) => s + res.stdout);
        if (res.stderr) setStderr((s) => s + res.stderr);
        setTruncated({ stdout: res.stdoutTruncated, stderr: res.stderrTruncated });
        const more = res.stdoutNext < res.stdoutLength || res.stderrNext < res.stderrLength;
        offsets.current = { stdoutFrom: res.stdoutNext, stderrFrom: res.stderrNext };
        setError(null);
        if (more) {
          timer = setTimeout(poll, 0);
        } else if (!res.done) {
          timer = setTimeout(poll, 1500);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load output");
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, serverId]);

  const out = stripAnsi(stdout);
  const err = stripAnsi(stderr);

  return (
    <div className="space-y-2">
      {error && <div className="text-xs text-destructive">{error}</div>}
      {!out && !err && <div className="text-xs text-muted-foreground">{live ? "Waiting for output…" : "No output."}</div>}
      {out && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 p-3 font-mono text-xs text-foreground">
          {out}
          {truncated.stdout && <span className="text-amber-400">{"\n"}[output truncated]</span>}
        </pre>
      )}
      {err && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">stderr</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-red-950/30 p-3 font-mono text-xs text-red-200">
            {err}
            {truncated.stderr && <span className="text-amber-400">{"\n"}[output truncated]</span>}
          </pre>
        </div>
      )}
    </div>
  );
}
