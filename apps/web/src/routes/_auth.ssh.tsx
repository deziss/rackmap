import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchServers, serverKeys, fetchMe, systemKeys } from "@/lib/queries";
import { authClient } from "@/lib/auth-client";
import { SshTerminal } from "@/components/ssh-terminal";
import { Server, Terminal, Plus, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { z } from "zod";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_auth/ssh")({
  validateSearch: z.object({ serverId: z.coerce.number().optional() }),
  component: SshPage,
});

interface Tab {
  id: string;
  serverId: number;
  hostname: string;
}

let tabCounter = 0;
function newTabId() { return `tab-${++tabCounter}`; }

function SshPage() {
  const { data: session } = authClient.useSession();
  const role = session?.user?.role;
  const canSsh = role === "admin" || role === "editor";
  const { serverId: preselectedId } = Route.useSearch();

  const [tabs, setTabs] = useState<Tab[]>(() => {
    if (preselectedId) return [{ id: newTabId(), serverId: preselectedId, hostname: `#${preselectedId}` }];
    return [];
  });
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    preselectedId ? `tab-1` : null
  );

  const { data, isLoading } = useQuery({
    queryKey: serverKeys.list({ limit: 100 }),
    queryFn: () => fetchServers({ limit: 100 }),
  });

  const { data: me } = useQuery({
    queryKey: systemKeys.me,
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
  });

  const sshEnabled = me?.features?.sshEnabled ?? true; // Default to true while loading

  const servers = data?.items || [];

  // Update hostname once servers load
  if (data && tabs.length > 0) {
    tabs.forEach((t) => {
      const s = servers.find((sv) => sv.id === t.serverId);
      if (s && t.hostname !== s.hostname) {
        t.hostname = s.hostname;
      }
    });
  }

  const onlineServers = servers.filter((s) => s.lastStatus === "up");
  const offlineServers = servers.filter((s) => s.lastStatus !== "up");

  function openTab(serverId: number, hostname: string) {
    const id = newTabId();
    setTabs((prev) => [...prev, { id, serverId, hostname }]);
    setActiveTabId(id);
  }

  function closeTab(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  }

  if (!canSsh) {
    return <div className="text-muted-foreground p-8">No SSH permission.</div>;
  }

  if (me && !sshEnabled) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-3rem)] text-muted-foreground p-8 text-center space-y-4">
        <Terminal className="w-16 h-16 opacity-20" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">SSH Terminal is Disabled</h2>
          <p className="mt-2 text-sm opacity-80 max-w-sm">
            The SSH feature is currently turned off system-wide. An administrator must enable the SSH kill-switch in the server configuration.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      {/* Page header */}
      <div className="flex flex-col gap-1 mb-4 shrink-0">
        <h1 className="text-3xl font-bold tracking-tight">SSH Terminal</h1>
        <p className="text-muted-foreground text-sm">Connect directly to your servers via WebSocket SSH tunnel.</p>
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Server list sidebar */}
        <div className="w-56 shrink-0 overflow-y-auto border border-border rounded-md bg-card p-3 space-y-3 shadow-sm">
          <Label className="text-xs font-semibold flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
            <Server className="w-3.5 h-3.5" /> Servers
          </Label>

          {isLoading ? (
            <div className="text-xs text-muted-foreground text-center py-4">Loading…</div>
          ) : servers.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No servers</div>
          ) : (
            <div className="space-y-3">
              {onlineServers.length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[10px] font-semibold text-green-500 mb-1.5 uppercase tracking-wider">
                    Online ({onlineServers.length})
                  </div>
                  {onlineServers.map((s) => (
                    <button
                      key={s.id}
                      className="w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors flex items-center justify-between group hover:bg-muted text-foreground"
                      onClick={() => openTab(s.id, s.hostname)}
                    >
                      <span className="truncate">{s.hostname}</span>
                      <Plus className="w-3 h-3 opacity-0 group-hover:opacity-60 shrink-0" />
                    </button>
                  ))}
                </div>
              )}

              {offlineServers.length > 0 && (
                <div className="space-y-0.5 pt-2 border-t border-border/50">
                  <div className="text-[10px] font-semibold text-red-500 mb-1.5 uppercase tracking-wider">
                    Offline ({offlineServers.length})
                  </div>
                  {offlineServers.map((s) => (
                    <button
                      key={s.id}
                      className="w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-muted text-muted-foreground flex items-center justify-between group"
                      onClick={() => openTab(s.id, s.hostname)}
                    >
                      <span className="truncate">{s.hostname}</span>
                      <Plus className="w-3 h-3 opacity-0 group-hover:opacity-60 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Terminal area */}
        <div className="flex-1 min-h-0 flex flex-col border border-border rounded-md shadow-sm overflow-hidden bg-zinc-950">
          {tabs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
              <Terminal className="w-14 h-14 mb-4 opacity-15" />
              <p className="font-medium text-sm">Click a server to open a session</p>
              <p className="text-xs mt-1 max-w-xs text-center opacity-70">
                Multiple sessions supported as tabs. Sessions use WebSocket proxy — no agent needed.
              </p>
            </div>
          ) : (
            <>
              {/* Tab bar */}
              <div className="flex items-center gap-0 bg-zinc-900 border-b border-zinc-800 overflow-x-auto shrink-0">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTabId(tab.id)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 text-xs font-mono border-r border-zinc-800 shrink-0 transition-colors group",
                      activeTabId === tab.id
                        ? "bg-zinc-950 text-zinc-100 border-t-2 border-t-primary -mt-px"
                        : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800",
                    )}
                  >
                    <Terminal className="w-3 h-3 shrink-0" />
                    <span className="max-w-32 truncate">{tab.hostname}</span>
                    <X
                      className="w-3 h-3 opacity-0 group-hover:opacity-70 hover:opacity-100 hover:text-red-400 shrink-0"
                      onClick={(e) => closeTab(tab.id, e)}
                    />
                  </button>
                ))}
              </div>

              {/* Tab panels — all mounted, hidden when inactive (preserves WS connection) */}
              <div className="flex-1 min-h-0 relative">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={cn(
                      "absolute inset-0",
                      activeTabId === tab.id ? "block" : "hidden",
                    )}
                  >
                    <SshTerminal
                      serverId={tab.serverId}
                      onClose={() => closeTab(tab.id, { stopPropagation: () => {} } as React.MouseEvent)}
                      className="h-full rounded-none border-0"
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
