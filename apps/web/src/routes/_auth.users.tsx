import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { UserPlus, Ban, RefreshCw, Pencil, KeyRound, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_auth/users")({
  component: UsersPage,
});

interface BetterUser {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
  createdAt: Date | string;
}

const ROLES = ["admin", "editor", "viewer"] as const;
type Role = (typeof ROLES)[number];

function UsersPage() {
  const qc = useQueryClient();
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await authClient.admin.listUsers({ query: { limit: 100 } });
      return res.data?.users as BetterUser[] ?? [];
    },
  });

  const setRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role }) => {
      await apiFetch(`/api/v1/users/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast.success("Role updated"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const ban = useMutation({
    mutationFn: async ({ userId, banned }: { userId: string; banned: boolean }) => {
      const path = banned ? "unban" : "ban";
      await apiFetch(`/api/v1/users/${userId}/${path}`, { method: "POST" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast.success("Updated"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeUser = useMutation({
    mutationFn: async (userId: string) => {
      await apiFetch(`/api/v1/users/${userId}`, { method: "DELETE" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast.success("User removed"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage user accounts and permissions</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
          <CreateUserDialog onCreated={() => qc.invalidateQueries({ queryKey: ["users"] })} />
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-md shadow-xl overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/8 bg-white/3">
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Name</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Role</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {data?.map((user) => (
              <tr key={user.id} className="border-b border-white/5 last:border-0 hover:bg-white/4 transition-colors">
                <td className="px-4 py-3 font-medium">{user.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                <td className="px-4 py-3">
                  <select
                    className="rounded border border-input bg-background px-2 py-1 text-xs"
                    value={user.role ?? "viewer"}
                    onChange={(e) => setRole.mutate({ userId: user.id, role: e.target.value as Role })}
                    disabled={user.id === currentUserId}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3">
                  {user.banned
                    ? <Badge variant="destructive" className="text-xs">Banned</Badge>
                    : <Badge variant="secondary" className="text-xs">Active</Badge>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <EditUserDialog user={user} onSaved={() => qc.invalidateQueries({ queryKey: ["users"] })} />
                    <SetPasswordDialog userId={user.id} userName={user.name} />
                    <Button
                      size="icon"
                      variant="ghost"
                      className={`h-7 w-7 ${user.banned ? "text-green-600" : "text-amber-500 hover:text-amber-400"}`}
                      onClick={() => ban.mutate({ userId: user.id, banned: !!user.banned })}
                      disabled={ban.isPending || user.id === currentUserId}
                      title={user.banned ? "Unban" : "Ban"}
                    >
                      <Ban className="h-3.5 w-3.5" />
                    </Button>
                    {user.id !== currentUserId && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove user?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This permanently removes <strong>{user.name}</strong> ({user.email}) and all their sessions. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => removeUser.mutate(user.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditUserDialog({ user, onSaved }: { user: BetterUser; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch(`/api/v1/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, email }),
      });
      toast.success("User updated");
      setOpen(false);
      onSaved();
    } catch (err: unknown) {
      toast.error((err as Error).message ?? "Failed to update user");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit user">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit User</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SetPasswordDialog({ userId, userName }: { userId: string; userName: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch(`/api/v1/users/${userId}/set-password`, {
        method: "POST",
        body: JSON.stringify({ newPassword: password }),
      });
      toast.success("Password reset");
      setOpen(false);
      setPassword("");
    } catch (err: unknown) {
      toast.error((err as Error).message ?? "Failed to reset password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="Set password">
          <KeyRound className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Reset Password — {userName}</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1">
            <Label>New Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              placeholder="Min. 8 characters"
              autoComplete="new-password"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Resetting…" : "Reset Password"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateUserDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await authClient.admin.createUser({ name, email, password, role });
      toast.success("User created");
      setOpen(false);
      setName(""); setEmail(""); setPassword(""); setRole("viewer");
      onCreated();
    } catch (err: unknown) {
      toast.error((err as Error).message ?? "Failed to create user");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><UserPlus className="h-4 w-4 mr-1" /> Add User</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Create User</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label>Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          <div className="space-y-1">
            <Label>Role</Label>
            <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Creating…" : "Create"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
