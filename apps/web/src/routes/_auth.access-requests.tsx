import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { CheckCircle, XCircle, RefreshCw, Clock, KeyRound, Terminal, Server } from "lucide-react";
function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const Route = createFileRoute("/_auth/access-requests")({
  component: AccessRequestsPage,
});

interface AccessRequest {
  id: number;
  type: "ssh" | "password_reveal";
  status: "pending" | "approved" | "rejected";
  note?: string | null;
  adminNote?: string | null;
  requestedAt: string;
  resolvedAt?: string | null;
  expiresAt?: string | null;
  requester: { id: string; name: string; email: string };
  server: { id: number; hostname: string; ip: string };
  resolver?: { id: string; name: string } | null;
}

function AccessRequestsPage() {
  const { data: session } = authClient.useSession();
  const role = session?.user?.role;
  const isAdmin = role === "admin";

  const qc = useQueryClient();
  const [resolveTarget, setResolveTarget] = useState<AccessRequest | null>(null);
  const [resolveStatus, setResolveStatus] = useState<"approved" | "rejected">("approved");
  const [adminNote, setAdminNote] = useState("");
  const [expiresInHours, setExpiresInHours] = useState(24);

  const { data, isLoading, refetch } = useQuery<AccessRequest[]>({
    queryKey: ["access-requests"],
    queryFn: () => apiFetch("/api/v1/access-requests"),
  });

  const resolve = useMutation({
    mutationFn: async ({ id, status, adminNote, expiresInHours }: { id: number; status: string; adminNote: string; expiresInHours: number }) => {
      return apiFetch(`/api/v1/access-requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, adminNote: adminNote || undefined, expiresInHours }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["access-requests"] });
      toast.success(resolveStatus === "approved" ? "Access approved" : "Request rejected");
      setResolveTarget(null);
      setAdminNote("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pending = data?.filter((r) => r.status === "pending") ?? [];
  const resolved = data?.filter((r) => r.status !== "pending") ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Access Requests</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {isAdmin ? "Review and approve viewer access requests" : "Your SSH and password reveal requests"}
          </p>
        </div>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Pending */}
      <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl">
        <div className="px-4 py-3 border-b border-white/8 flex items-center gap-2">
          <Clock className="h-4 w-4 text-amber-500" />
          <span className="font-semibold text-sm">Pending</span>
          {pending.length > 0 && (
            <Badge variant="destructive" className="text-xs ml-1">{pending.length}</Badge>
          )}
        </div>
        {pending.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted-foreground text-sm">No pending requests</div>
        ) : (
          <div className="divide-y divide-white/5">
            {pending.map((req) => (
              <RequestRow
                key={req.id}
                req={req}
                isAdmin={isAdmin}
                onApprove={() => { setResolveTarget(req); setResolveStatus("approved"); }}
                onReject={() => { setResolveTarget(req); setResolveStatus("rejected"); }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Resolved */}
      {resolved.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl">
          <div className="px-4 py-3 border-b border-white/8 flex items-center gap-2">
            <span className="font-semibold text-sm text-muted-foreground">Recent History</span>
          </div>
          <div className="divide-y divide-white/5">
            {resolved.slice(0, 20).map((req) => (
              <RequestRow key={req.id} req={req} isAdmin={isAdmin} />
            ))}
          </div>
        </div>
      )}

      {/* Resolve dialog */}
      <Dialog open={!!resolveTarget} onOpenChange={(o) => !o && setResolveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{resolveStatus === "approved" ? "Approve Access" : "Reject Request"}</DialogTitle>
          </DialogHeader>
          {resolveTarget && (
            <div className="space-y-4 mt-2">
              <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-1">
                <div className="flex gap-2"><span className="text-muted-foreground">User:</span><strong>{resolveTarget.requester.name}</strong></div>
                <div className="flex gap-2"><span className="text-muted-foreground">Server:</span><strong>{resolveTarget.server.hostname}</strong></div>
                <div className="flex gap-2"><span className="text-muted-foreground">Type:</span><strong>{resolveTarget.type === "ssh" ? "SSH Terminal" : "Password Reveal"}</strong></div>
                {resolveTarget.note && <div className="flex gap-2"><span className="text-muted-foreground">Note:</span><span>{resolveTarget.note}</span></div>}
              </div>
              {resolveStatus === "approved" && (
                <div className="space-y-1">
                  <Label>Access valid for (hours)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={720}
                    value={expiresInHours}
                    onChange={(e) => setExpiresInHours(Number(e.target.value))}
                    className="h-8 w-32 text-sm"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label>Admin note (optional)</Label>
                <Input
                  value={adminNote}
                  onChange={(e) => setAdminNote(e.target.value)}
                  placeholder={resolveStatus === "rejected" ? "Reason for rejection…" : "Access instructions…"}
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setResolveTarget(null)}>Cancel</Button>
                <Button
                  variant={resolveStatus === "approved" ? "default" : "destructive"}
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate({
                    id: resolveTarget.id,
                    status: resolveStatus,
                    adminNote,
                    expiresInHours,
                  })}
                >
                  {resolve.isPending ? "…" : resolveStatus === "approved" ? "Approve" : "Reject"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RequestRow({
  req,
  isAdmin,
  onApprove,
  onReject,
}: {
  req: AccessRequest;
  isAdmin: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const TypeIcon = req.type === "ssh" ? Terminal : KeyRound;

  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <div className="mt-0.5 text-muted-foreground">
        <TypeIcon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{req.requester.name}</span>
          <span className="text-muted-foreground text-xs">requested</span>
          <Badge variant="outline" className="text-xs">{req.type === "ssh" ? "SSH Terminal" : "Password Reveal"}</Badge>
          <span className="text-muted-foreground text-xs">for</span>
          <span className="font-mono text-xs flex items-center gap-1"><Server className="h-3 w-3" />{req.server.hostname}</span>
        </div>
        {req.note && <p className="text-xs text-muted-foreground mt-0.5 truncate">"{req.note}"</p>}
        {req.adminNote && <p className="text-xs text-muted-foreground mt-0.5 truncate">Admin: "{req.adminNote}"</p>}
        <p className="text-xs text-muted-foreground mt-0.5">
          {timeAgo(req.requestedAt)}
          {req.expiresAt && req.status === "approved" && (
            <> · expires {timeAgo(req.expiresAt)}</>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <StatusBadge status={req.status} />
        {isAdmin && req.status === "pending" && (
          <>
            <Button size="sm" variant="ghost" className="h-7 text-green-500 hover:text-green-400" onClick={onApprove}>
              <CheckCircle className="h-3.5 w-3.5 mr-1" /> Approve
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-destructive hover:text-destructive" onClick={onReject}>
              <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "pending") return <Badge variant="secondary" className="text-xs bg-amber-500/20 text-amber-400 border-amber-500/30">Pending</Badge>;
  if (status === "approved") return <Badge variant="secondary" className="text-xs bg-green-500/20 text-green-400 border-green-500/30">Approved</Badge>;
  return <Badge variant="destructive" className="text-xs">Rejected</Badge>;
}
