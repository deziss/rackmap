import { useMemo } from "react";
import { cn } from "@/lib/utils";

type DiffLine = { kind: "same" | "add" | "del"; text: string };

const MAX_LINES = 1500;

/** Line diff by longest common subsequence. Scripts are ≤64 KB, so O(n·m) is fine up to MAX_LINES. */
function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i++]! });
    } else {
      out.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/**
 * What an approver needs to see: the script this run will execute (the snapshot
 * taken at request time) against the runbook as it is now. Removed lines are
 * in the snapshot only; added lines exist only in the current version.
 */
export function ScriptDiff({ snapshot, current }: { snapshot: string; current: string }) {
  const lines = useMemo(() => {
    const a = snapshot.split("\n");
    const b = current.split("\n");
    if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
    return diffLines(a, b);
  }, [snapshot, current]);

  if (!lines) {
    return <p className="text-xs text-muted-foreground">Scripts are too long to diff here; compare the two versions directly.</p>;
  }
  return (
    <pre className="max-h-96 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs">
      {lines.map((l, idx) => (
        <div
          key={idx}
          className={cn(
            "whitespace-pre-wrap break-all",
            l.kind === "add" && "bg-emerald-500/10 text-emerald-300",
            l.kind === "del" && "bg-red-500/10 text-red-300",
          )}
        >
          {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
          {l.text}
        </div>
      ))}
    </pre>
  );
}
