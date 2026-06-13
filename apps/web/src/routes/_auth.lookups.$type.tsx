import { createFileRoute } from "@tanstack/react-router";
import { LOOKUP_TYPES, LOOKUP_TYPE_KEYS, type LookupType } from "@inv/shared";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useState } from "react";
import { Pencil, Trash2, Plus } from "lucide-react";

export const Route = createFileRoute("/_auth/lookups/$type")({
  component: LookupPage,
});

interface LookupEntry { id: number; name: string }

function LookupPage() {
  const { type } = Route.useParams();
  const label = LOOKUP_TYPES[type as LookupType] ?? type;
  const qc = useQueryClient();

  const { data = [], isLoading } = useQuery<LookupEntry[]>({
    queryKey: ["lookups", type],
    queryFn: () => apiFetch(`/api/v1/lookups/${type}`),
    enabled: LOOKUP_TYPE_KEYS.includes(type as LookupType),
  });

  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const create = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/v1/lookups/${type}`, { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["lookups", type] }); setNewName(""); toast.success("Created"); },
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["lookups", type] }); toast.success("Deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-xl font-semibold">{label}</h1>

      {/* Add new */}
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); if (newName.trim()) create.mutate(newName.trim()); }}
      >
        <Input
          placeholder={`New ${label.toLowerCase()}…`}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" size="sm" disabled={create.isPending || !newName.trim()}>
          <Plus className="h-4 w-4 mr-1" /> Add
        </Button>
      </form>

      {/* List */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border">
          {data.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 px-3 py-2">
              {editId === entry.id ? (
                <>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 h-7 text-sm"
                    autoFocus
                  />
                  <Button size="sm" variant="default" onClick={() => update.mutate({ id: entry.id, name: editName })} disabled={update.isPending}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditId(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm">{entry.name}</span>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditId(entry.id); setEditName(entry.name); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => remove.mutate(entry.id)} disabled={remove.isPending}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
          {data.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-muted-foreground">No entries yet</li>
          )}
        </ul>
      )}
    </div>
  );
}
