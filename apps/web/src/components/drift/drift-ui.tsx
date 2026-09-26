import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  DRIFT_CATEGORY_LABELS,
  type DriftChangeItem,
  type DriftEventDto,
  type DriftSeverity,
} from "@inv/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Check, Loader2, Minus, Pencil, Plus } from "lucide-react";
import { fetchMe, systemKeys } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Shared bits for the drift page and the server drift card. */

export function useDriftPermissions() {
  const { data: me } = useQuery({ queryKey: systemKeys.me, queryFn: fetchMe, staleTime: 60_000 });
  const can = (me?.can ?? {}) as Record<string, boolean>;
  return {
    canRead: !!can["drift.read"],
    canAcknowledge: !!can["drift.acknowledge"],
    /** Accepting a baseline needs drift:acknowledge AND server:sudo. */
    canBaseline: !!can["drift.acknowledge"] && !!can["server.sudo"],
  };
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

const SEVERITY_VARIANT: Record<DriftSeverity, "destructive" | "warning" | "secondary"> = {
  critical: "destructive",
  warning: "warning",
  info: "secondary",
};

export function DriftSeverityBadge({ severity, className }: { severity: DriftSeverity; className?: string }) {
  return (
    <Badge variant={SEVERITY_VARIANT[severity]} className={cn("text-[10px] px-1.5 py-0 uppercase tracking-wide", className)}>
      {severity}
    </Badge>
  );
}

const ITEM_ICON = { added: Plus, removed: Minus, changed: Pencil } as const;
const ITEM_TONE = { added: "text-emerald-400", removed: "text-red-400", changed: "text-amber-400" } as const;

function ChangeList({ kind, items }: { kind: "added" | "removed" | "changed"; items: DriftChangeItem[] }) {
  if (items.length === 0) return null;
  const Icon = ITEM_ICON[kind];
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={`${kind}:${item.key}`} className="flex items-start gap-2 text-xs">
          <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", ITEM_TONE[kind])} aria-label={kind} />
          <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground/90">{item.label}</span>
          {item.severity !== "info" && <DriftSeverityBadge severity={item.severity} className="shrink-0" />}
        </li>
      ))}
    </ul>
  );
}

/** One event: summary line, expandable change list, acknowledge button. */
export function DriftEventRow({
  event,
  canAcknowledge,
  onAcknowledge,
  acknowledging,
  showServer = false,
}: {
  event: DriftEventDto;
  canAcknowledge: boolean;
  onAcknowledge?: (event: DriftEventDto) => void;
  acknowledging?: boolean;
  showServer?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { added, removed, changed, omitted } = event.changes;
  const count = added.length + removed.length + changed.length + (omitted ?? 0);
  return (
    <li className="py-2">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={open ? "Hide changes" : "Show changes"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <DriftSeverityBadge severity={event.severity} />
            <span className="text-xs font-medium">{DRIFT_CATEGORY_LABELS[event.category] ?? event.category}</span>
            {showServer && event.server && <span className="text-xs text-muted-foreground">on {event.server.hostname}</span>}
            <span className="text-[11px] text-muted-foreground">
              {count} change{count === 1 ? "" : "s"} · {relativeTime(event.detectedAt)}
            </span>
          </div>
          <button type="button" onClick={() => setOpen((o) => !o)} className="block w-full text-left">
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={event.summary}>
              {event.summary}
            </p>
          </button>
          {event.acknowledgedAt && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Acknowledged {relativeTime(event.acknowledgedAt)}
              {event.acknowledgedBy ? ` by ${event.acknowledgedBy.name || event.acknowledgedBy.email}` : ""}
            </p>
          )}
          {open && (
            <div className="mt-2 space-y-2 rounded-md border border-white/10 bg-black/20 p-2.5">
              <ChangeList kind="added" items={added} />
              <ChangeList kind="changed" items={changed} />
              <ChangeList kind="removed" items={removed} />
              {omitted ? <p className="text-[11px] text-muted-foreground">…and {omitted} more not shown</p> : null}
            </div>
          )}
        </div>
        {canAcknowledge && !event.acknowledgedAt && onAcknowledge && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1 text-xs"
            disabled={acknowledging}
            onClick={() => onAcknowledge(event)}
          >
            {acknowledging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Acknowledge
          </Button>
        )}
      </div>
    </li>
  );
}
