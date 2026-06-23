import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";

export const Route = createFileRoute("/_auth/audit")({
  component: AuditPage,
});

interface AuditEntry {
  id: number;
  category: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  actorEmail: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  diffJson: string | null;
  ip: string | null;
  createdAt: string;
}

interface AuditResponse {
  items: AuditEntry[];
  nextCursor: number | null;
}

const ACTION_COLORS: Record<string, string> = {
  "server.create": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "server.update": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "server.delete": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "server.restore": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "server.password_reveal": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "auth.sign_in": "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  "auth.sign_in_failed": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "auth.sign_out": "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

function formatDate(ts: string) {
  return new Date(ts).toLocaleString();
}

function DiffViewer({ before, after, diff }: { before: string | null; after: string | null; diff: string | null }) {
  if (!before && !after && !diff) return null;

  const renderObj = (json: string | null, label: string, cls: string) => {
    if (!json) return null;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(json); } catch { return <p className="text-xs text-muted-foreground">Invalid JSON</p>; }
    return (
      <div className={`rounded p-2 text-xs font-mono ${cls}`}>
        <p className="font-semibold mb-1 font-sans">{label}</p>
        {Object.entries(parsed).map(([k, v]) => (
          <div key={k}><span className="text-muted-foreground">{k}: </span><span>{JSON.stringify(v)}</span></div>
        ))}
      </div>
    );
  };

  if (diff) return renderObj(diff, "Changes", "bg-blue-50 dark:bg-blue-950/20");

  return (
    <div className="grid grid-cols-2 gap-2 mt-2">
      {renderObj(before, "Before", "bg-red-50 dark:bg-red-950/20")}
      {renderObj(after, "After", "bg-green-50 dark:bg-green-950/20")}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDiff = !!(entry.beforeJson || entry.afterJson || entry.diffJson);

  return (
    <div className="border-b border-border last:border-0">
      <div
        className={`flex items-start gap-3 px-4 py-3 text-sm hover:bg-muted/30 ${hasDiff ? "cursor-pointer" : ""}`}
        onClick={() => hasDiff && setExpanded(!expanded)}
      >
        {hasDiff ? (
          expanded
            ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        ) : <span className="w-4 shrink-0" />}

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${ACTION_COLORS[entry.action] ?? "bg-muted text-muted-foreground"}`}>
              {entry.action}
            </span>
            {entry.entity && (
              <span className="text-muted-foreground text-xs">{entry.entity} #{entry.entityId}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span>{entry.actorEmail ?? "system"}</span>
            {entry.ip && <span>{entry.ip}</span>}
            <span className="ml-auto">{formatDate(entry.createdAt)}</span>
          </div>
        </div>
      </div>

      {expanded && hasDiff && (
        <div className="px-10 pb-3">
          <DiffViewer before={entry.beforeJson} after={entry.afterJson} diff={entry.diffJson} />
        </div>
      )}
    </div>
  );
}

function groupByDay(items: AuditEntry[]) {
  const groups: { label: string; entries: AuditEntry[] }[] = [];
  for (const entry of items) {
    const day = new Date(entry.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last?.label === day) { last.entries.push(entry); }
    else { groups.push({ label: day, entries: [entry] }); }
  }
  return groups;
}

function AuditPage() {
  const [cursor, setCursor] = useState<number | null>(null);
  const [cursorHistory, setCursorHistory] = useState<number[]>([]);
  const [category, setCategory] = useState("");
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");

  const buildParams = (cur: number | null) => {
    const p = new URLSearchParams({ limit: "50" });
    if (cur) p.set("cursor", String(cur));
    if (category) p.set("category", category);
    if (action) p.set("action", action);
    if (search) p.set("search", search);
    return p.toString();
  };

  const { data, isLoading, refetch } = useQuery<AuditResponse>({
    queryKey: ["audit", cursor, category, action, search],
    queryFn: () => apiFetch<AuditResponse>(`/api/v1/audit?${buildParams(cursor)}`),
  });

  const allItems = data?.items ?? [];
  const grouped = groupByDay(allItems);

  function reset() {
    setCursor(null);
    setCursorHistory([]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold mr-auto">Audit Log</h1>
        <Input
          placeholder="Search IP, name, domain..."
          className="w-48 h-8 text-sm"
          value={search}
          onChange={(e) => { setSearch(e.target.value); reset(); }}
        />
        <Input
          placeholder="Category (data/auth/notification)"
          className="w-56 h-8 text-sm"
          value={category}
          onChange={(e) => { setCategory(e.target.value); reset(); }}
        />
        <Input
          placeholder="Action filter…"
          className="w-48 h-8 text-sm"
          value={action}
          onChange={(e) => { setAction(e.target.value); reset(); }}
        />
        <Button size="sm" variant="outline" onClick={() => { reset(); refetch(); }}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="rounded-md border">
        {isLoading && allItems.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        )}
        {!isLoading && allItems.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No audit entries</p>
        )}
        {grouped.map((group) => (
          <div key={group.label}>
            <div className="sticky top-0 px-4 py-1.5 text-xs font-medium text-muted-foreground bg-muted/70 border-b border-border backdrop-blur-sm">
              {group.label}
            </div>
            {group.entries.map((e) => <AuditRow key={e.id} entry={e} />)}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground mt-4">
        <span>{data?.total ?? 0} entries</span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const prev = cursorHistory[cursorHistory.length - 1];
              setCursorHistory((h) => h.slice(0, -1));
              setCursor(prev === 0 ? null : prev);
            }}
            disabled={cursorHistory.length === 0 || isLoading}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCursorHistory((h) => [...h, cursor ?? 0]);
              setCursor(data!.nextCursor!);
            }}
            disabled={!data?.nextCursor || isLoading}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
