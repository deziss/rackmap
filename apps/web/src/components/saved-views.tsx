import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bookmark, BookmarkPlus, Trash2, ChevronDown } from "lucide-react";
import { toast } from "sonner";

interface SavedView {
  id: number;
  name: string;
  paramsJson: string;
  updatedAt: string;
}

interface SavedViewsProps {
  currentParams: Record<string, string>;
  onLoad: (params: Record<string, string>) => void;
}

async function fetchViews(): Promise<SavedView[]> {
  const res = await fetch("/api/v1/views");
  if (!res.ok) throw new Error("Failed to load saved views");
  return res.json() as Promise<SavedView[]>;
}

export function SavedViews({ currentParams, onLoad }: SavedViewsProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  const { data: views = [] } = useQuery<SavedView[]>({ queryKey: ["views"], queryFn: fetchViews });

  const save = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/v1/views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, paramsJson: JSON.stringify(currentParams) }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["views"] }); toast.success("View saved"); setSaveName(""); },
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/v1/views/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["views"] }); toast.success("View deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} className="gap-1.5">
        <Bookmark className="h-3.5 w-3.5" />
        Views
        <ChevronDown className="h-3 w-3" />
      </Button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-64 rounded-md border border-border bg-background shadow-lg">
          {/* Save current */}
          <div className="p-2 border-b border-border">
            <form
              className="flex gap-1.5"
              onSubmit={(e) => { e.preventDefault(); if (saveName.trim()) save.mutate(saveName.trim()); }}
            >
              <Input
                placeholder="Save current view…"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                className="h-7 text-xs flex-1"
              />
              <Button type="submit" size="sm" className="h-7 px-2" disabled={!saveName.trim() || save.isPending}>
                <BookmarkPlus className="h-3.5 w-3.5" />
              </Button>
            </form>
          </div>

          {/* Saved list */}
          <div className="max-h-48 overflow-y-auto py-1">
            {views.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">No saved views</p>
            )}
            {views.map((v) => (
              <div key={v.id} className="flex items-center gap-1 px-2 py-1 hover:bg-accent group">
                <button
                  className="flex-1 text-left text-sm truncate"
                  onClick={() => {
                    try { onLoad(JSON.parse(v.paramsJson) as Record<string, string>); setOpen(false); }
                    catch { toast.error("Invalid saved view"); }
                  }}
                >
                  {v.name}
                </button>
                <button
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  onClick={() => del.mutate(v.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
