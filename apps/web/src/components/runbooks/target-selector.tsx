import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunbookTargetSelector } from "@inv/shared";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { fetchServers, lookupKeys, serverKeys } from "@/lib/queries";
import { fetchLocationsList, fetchTagsList } from "@/lib/runbooks-api";

const ENVIRONMENTS = ["on-premise", "cloud"];

function Chip({ active, onClick, children, disabled }: { active: boolean; onClick(): void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50",
        active ? "border-primary/60 bg-primary/20 text-primary" : "border-white/15 bg-white/5 text-muted-foreground hover:bg-white/10",
      )}
    >
      {children}
    </button>
  );
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/**
 * Target selector for the runbook editor. Tags, environments and locations are
 * ANDed with each other (values inside one group are ORed); explicitly selected
 * servers are added on top; excluded servers are removed last. Nothing selected
 * matches nothing — the API refuses an empty selector.
 */
export function TargetSelector({
  value,
  onChange,
  disabled,
}: {
  value: RunbookTargetSelector;
  onChange(v: RunbookTargetSelector): void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const tags = useQuery({ queryKey: ["tags"], queryFn: fetchTagsList });
  const locations = useQuery({ queryKey: lookupKeys.list("locations"), queryFn: fetchLocationsList });
  const servers = useQuery({
    queryKey: serverKeys.list({ limit: 1000, purpose: "runbook-targets" }),
    queryFn: () => fetchServers({ limit: 1000 }),
    staleTime: 60_000,
  });

  const allServers = servers.data?.items ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? allServers.filter((s) => s.hostname.toLowerCase().includes(q) || s.ip.includes(q)) : allServers;
    return list.slice(0, 200);
  }, [allServers, search]);

  const set = (patch: Partial<RunbookTargetSelector>) => onChange({ ...value, ...patch });
  const environments = Array.from(new Set([...ENVIRONMENTS, ...allServers.map((s) => s.environment).filter((e): e is string => !!e)]));

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground">Tags (any of)</div>
        <div className="flex flex-wrap gap-1.5">
          {(tags.data ?? []).map((t) => (
            <Chip key={t.id} disabled={disabled} active={value.tagIds.includes(t.id)} onClick={() => set({ tagIds: toggle(value.tagIds, t.id) })}>
              {t.name}
            </Chip>
          ))}
          {tags.data?.length === 0 && <span className="text-xs text-muted-foreground">No tags defined.</span>}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground">Environments (any of)</div>
        <div className="flex flex-wrap gap-1.5">
          {environments.map((e) => (
            <Chip key={e} disabled={disabled} active={value.environments.includes(e)} onClick={() => set({ environments: toggle(value.environments, e) })}>
              {e}
            </Chip>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground">Locations (any of)</div>
        <div className="flex flex-wrap gap-1.5">
          {(locations.data ?? []).map((l) => (
            <Chip key={l.id} disabled={disabled} active={value.locationIds.includes(l.id)} onClick={() => set({ locationIds: toggle(value.locationIds, l.id) })}>
              {l.name}
            </Chip>
          ))}
          {locations.data?.length === 0 && <span className="text-xs text-muted-foreground">No locations defined.</span>}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="text-xs font-medium text-muted-foreground">Servers</div>
          <span className="text-[11px] text-muted-foreground">
            {value.serverIds.length} added · {value.excludeServerIds.length} excluded
          </span>
        </div>
        <Input className="h-8 text-xs" placeholder="Filter by hostname or IP" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="max-h-56 overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/5">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>Host</span>
            <span>Add</span>
            <span>Exclude</span>
          </div>
          {filtered.map((s) => (
            <div key={s.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-1 text-xs">
              <span className="truncate">
                <span className="font-medium">{s.hostname}</span> <span className="font-mono text-muted-foreground">{s.ip}</span>
              </span>
              <Checkbox
                disabled={disabled}
                checked={value.serverIds.includes(s.id)}
                onCheckedChange={() => set({ serverIds: toggle(value.serverIds, s.id) })}
              />
              <Checkbox
                disabled={disabled}
                checked={value.excludeServerIds.includes(s.id)}
                onCheckedChange={() => set({ excludeServerIds: toggle(value.excludeServerIds, s.id) })}
              />
            </div>
          ))}
          {servers.isLoading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading servers…</div>}
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <Switch checked={value.onlyUp} disabled={disabled} onCheckedChange={(c) => set({ onlyUp: c })} />
        Only servers currently up
      </label>
    </div>
  );
}
