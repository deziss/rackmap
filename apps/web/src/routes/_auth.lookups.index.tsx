import { createFileRoute } from "@tanstack/react-router";
import { LOOKUP_TYPES, LOOKUP_TYPE_KEYS, type LookupType } from "@inv/shared";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useState } from "react";
import { Pencil, Trash2, Plus, Check, X, AlertTriangle, Cloud, Cpu, User, MapPin, Server } from "lucide-react";

export const Route = createFileRoute("/_auth/lookups/")({
  component: LookupsPage,
});

interface LookupEntry { id: number; name: string }

const TYPE_ICONS: Record<LookupType, React.ElementType> = {
  "cloud-providers": Cloud,
  "gpu-types": Cpu,
  "allocated-to": User,
  "locations": MapPin,
  "server-types": Server,
};

function LookupTable({ type }: { type: LookupType }) {
  const label = LOOKUP_TYPES[type];
  const Icon = TYPE_ICONS[type];
  const qc = useQueryClient();

  const { data = [], isLoading } = useQuery<LookupEntry[]>({
    queryKey: ["lookups", type],
    queryFn: () => apiFetch(`/api/v1/lookups/${type}`),
  });

  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<LookupEntry | null>(null);

  const create = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/v1/lookups/${type}`, { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["lookups", type] }); setNewName(""); toast.success(`${label} created`); },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiFetch(`/api/v1/lookups/${type}/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["lookups", type] }); setEditId(null); toast.success("Updated"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/v1/lookups/${type}/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["lookups", type] }); setDeleteTarget(null); toast.success(`${label} deleted`); },
    onError: (e: Error) => { toast.error(e.message); setDeleteTarget(null); },
  });

  return (
    <>
      <div className="rounded-xl border border-white/10 bg-card/60 backdrop-blur-xl shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/8 bg-white/3">
          <Icon className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">{label}</h3>
          <span className="ml-auto text-xs text-muted-foreground bg-white/8 px-2 py-0.5 rounded-full">{data.length}</span>
        </div>

        {/* Add row */}
        <form
          className="flex gap-2 p-3 border-b border-white/8"
          onSubmit={(e) => { e.preventDefault(); if (newName.trim()) create.mutate(newName.trim()); }}
        >
          <Input
            placeholder={`Add ${label.toLowerCase()}…`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 h-8 text-sm"
          />
          <Button type="submit" size="sm" className="h-8 px-3 gap-1" disabled={create.isPending || !newName.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </form>

        {/* List */}
        <div className="max-h-64 overflow-y-auto">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : data.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">No entries yet</p>
          ) : (
            data.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2 px-3 py-2 border-b border-white/5 last:border-0 hover:bg-white/4 transition-colors group">
                {editId === entry.id ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="flex-1 h-7 text-sm"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") update.mutate({ id: entry.id, name: editName });
                        if (e.key === "Escape") setEditId(null);
                      }}
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-500" onClick={() => update.mutate({ id: entry.id, name: editName })} disabled={update.isPending}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditId(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm truncate">{entry.name}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditId(entry.id); setEditName(entry.name); }}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteTarget(entry)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="flex items-center justify-center h-10 w-10 rounded-full bg-destructive/15 shrink-0">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
            </div>
            <AlertDialogDescription>
              <span className="font-mono text-foreground">{deleteTarget?.name}</span> will be removed.
              This fails if servers are using it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function LookupsPage() {
  return (
    <div className="space-y-6">
      <div className="animate-fade-up">
        <h1 className="text-xl font-semibold tracking-tight">Lookup Management</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage dropdown values used in server forms</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {LOOKUP_TYPE_KEYS.map((type, i) => (
          <div key={type} className="animate-fade-up" style={{ animationDelay: `${i * 60}ms` }}>
            <LookupTable type={type as LookupType} />
          </div>
        ))}
      </div>
    </div>
  );
}
