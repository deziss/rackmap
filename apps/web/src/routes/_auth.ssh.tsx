import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchServers, serverKeys } from "@/lib/queries";
import { authClient } from "@/lib/auth-client";
import { SshTerminal } from "@/components/ssh-terminal";
import { Server, Terminal } from "lucide-react";
import { Label } from "@/components/ui/label";
import { z } from "zod";

export const Route = createFileRoute("/_auth/ssh")({
  validateSearch: z.object({ serverId: z.coerce.number().optional() }),
  component: SshPage,
});

function SshPage() {
  const { data: session } = authClient.useSession();
  const role = session?.user?.role;
  const canSsh = role === "admin" || role === "editor";
  const { serverId: preselectedId } = Route.useSearch();

  const [selectedServerId, setSelectedServerId] = useState<number | null>(preselectedId ?? null);

  const { data, isLoading } = useQuery({
    queryKey: serverKeys.list({ limit: 100 }),
    queryFn: () => fetchServers({ limit: 100 }),
  });

  if (!canSsh) {
    return <div className="text-muted-foreground p-8">You do not have permission to access the SSH terminal.</div>;
  }

  const servers = data?.items || [];
  const onlineServers = servers.filter(s => s.lastStatus === "up");
  const offlineServers = servers.filter(s => s.lastStatus !== "up");

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="flex flex-col gap-1 mb-4 shrink-0">
        <h1 className="text-3xl font-bold tracking-tight">SSH Terminal</h1>
        <p className="text-muted-foreground">Connect directly to your servers via WebSocket SSH tunnel.</p>
      </div>

      <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0">
        <div className="w-full md:w-64 shrink-0 overflow-y-auto border border-border rounded-md bg-card p-4 space-y-4 shadow-sm">
          <Label className="text-sm font-semibold flex items-center gap-2 text-muted-foreground">
            <Server className="w-4 h-4" /> Available Servers
          </Label>
          
          {isLoading ? (
            <div className="text-sm text-muted-foreground text-center py-4">Loading servers...</div>
          ) : servers.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">No servers available</div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2 uppercase tracking-wider">Online ({onlineServers.length})</div>
                {onlineServers.map(s => (
                  <button
                    key={s.id}
                    className={`w-full text-left px-3 py-2 rounded text-sm transition-colors flex items-center justify-between ${selectedServerId === s.id ? "bg-primary text-primary-foreground font-medium" : "hover:bg-muted"}`}
                    onClick={() => setSelectedServerId(s.id)}
                  >
                    <span className="truncate">{s.hostname}</span>
                  </button>
                ))}
              </div>
              
              {offlineServers.length > 0 && (
                <div className="space-y-1 pt-2 border-t border-border/50">
                  <div className="text-xs font-semibold text-red-600 dark:text-red-400 mb-2 uppercase tracking-wider">Offline ({offlineServers.length})</div>
                  {offlineServers.map(s => (
                    <button
                      key={s.id}
                      className={`w-full text-left px-3 py-2 rounded text-sm transition-colors flex items-center justify-between opacity-60 ${selectedServerId === s.id ? "bg-primary text-primary-foreground font-medium opacity-100" : "hover:bg-muted"}`}
                      onClick={() => setSelectedServerId(s.id)}
                    >
                      <span className="truncate">{s.hostname}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 border border-border rounded-md shadow-sm overflow-hidden flex flex-col bg-card">
          {selectedServerId ? (
            <div className="flex-1 flex flex-col h-full p-1 bg-black">
              <div className="text-xs font-mono text-zinc-400 p-2 flex justify-between items-center bg-zinc-900 border-b border-zinc-800">
                <span>Connecting to {servers.find(s => s.id === selectedServerId)?.hostname}...</span>
                <button className="text-zinc-500 hover:text-zinc-300" onClick={() => setSelectedServerId(null)}>Close</button>
              </div>
              <div className="flex-1 relative overflow-hidden">
                <SshTerminal serverId={selectedServerId} onClose={() => setSelectedServerId(null)} />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
              <Terminal className="w-16 h-16 mb-4 opacity-20" />
              <p className="font-medium">Select a server to initiate an SSH session</p>
              <p className="text-sm mt-1 max-w-sm text-center">Sessions are established securely via WebSocket proxy. No agent installation is required on the remote hosts.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
