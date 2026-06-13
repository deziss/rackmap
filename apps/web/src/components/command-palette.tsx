import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { Server, List, Users, Clock, LogOut, Sun, Search, Shield } from "lucide-react";

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  action: () => void;
  keywords?: string[];
}

interface CommandPaletteProps {
  userRole?: string;
}

export function CommandPalette({ userRole }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  function toggleTheme() {
    document.documentElement.classList.toggle("dark");
    localStorage.setItem("theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
  }

  const commands: Command[] = [
    { id: "servers", label: "Go to Servers", icon: <Server className="h-4 w-4" />, action: () => navigate({ to: "/servers" }), keywords: ["server", "list"] },
    { id: "domains", label: "Go to Lookups → Domains", icon: <List className="h-4 w-4" />, action: () => navigate({ to: "/lookups/$type", params: { type: "domains" } }), keywords: ["lookup", "domain"] },
    { id: "gpu-types", label: "Go to Lookups → GPU Types", icon: <List className="h-4 w-4" />, action: () => navigate({ to: "/lookups/$type", params: { type: "gpu-types" } }), keywords: ["lookup", "gpu"] },
    { id: "locations", label: "Go to Lookups → Locations", icon: <List className="h-4 w-4" />, action: () => navigate({ to: "/lookups/$type", params: { type: "locations" } }), keywords: ["lookup", "location"] },
    { id: "allocated-to", label: "Go to Lookups → Allocated To", icon: <List className="h-4 w-4" />, action: () => navigate({ to: "/lookups/$type", params: { type: "allocated-to" } }), keywords: ["lookup", "allocated"] },
    { id: "server-types", label: "Go to Lookups → Server Types", icon: <List className="h-4 w-4" />, action: () => navigate({ to: "/lookups/$type", params: { type: "server-types" } }), keywords: ["lookup", "type"] },
    ...(userRole === "admin" ? [
      { id: "users", label: "Go to Users", icon: <Users className="h-4 w-4" />, action: () => navigate({ to: "/users" }), keywords: ["user", "admin"] },
      { id: "audit", label: "Go to Audit Log", icon: <Clock className="h-4 w-4" />, action: () => navigate({ to: "/audit" }), keywords: ["audit", "log", "history"] },
    ] : []),
    { id: "security", label: "Go to Security / 2FA / API Keys", icon: <Shield className="h-4 w-4" />, action: () => navigate({ to: "/security" }), keywords: ["2fa", "totp", "api key", "security"] },
    { id: "theme", label: "Toggle Dark / Light Mode", icon: <Sun className="h-4 w-4" />, action: toggleTheme, keywords: ["dark", "light", "theme"] },
    { id: "signout", label: "Sign Out", icon: <LogOut className="h-4 w-4" />, action: async () => { await authClient.signOut(); window.location.href = "/login"; }, keywords: ["logout", "sign out"] },
  ];

  const filtered = query.trim()
    ? commands.filter((c) => {
        const q = query.toLowerCase();
        return c.label.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q) || c.keywords?.some((k) => k.includes(q));
      })
    : commands;

  const handleOpen = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setOpen((v) => !v);
      setQuery("");
      setSelected(0);
    }
    if (e.key === "Escape") setOpen(false);
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleOpen);
    return () => window.removeEventListener("keydown", handleOpen);
  }, [handleOpen]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    if (e.key === "Enter") {
      const cmd = filtered[selected];
      if (cmd) { cmd.action(); setOpen(false); }
    }
    if (e.key === "Escape") setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-background shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search commands…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="text-xs text-muted-foreground rounded border border-border px-1.5 py-0.5">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No commands match</p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors ${i === selected ? "bg-accent" : "hover:bg-accent/50"}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => { cmd.action(); setOpen(false); }}
              >
                <span className="text-muted-foreground shrink-0">{cmd.icon}</span>
                <span className="flex-1">{cmd.label}</span>
                {cmd.description && <span className="text-xs text-muted-foreground">{cmd.description}</span>}
              </button>
            ))
          )}
        </div>

        <div className="border-t border-border px-4 py-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span><kbd className="rounded border border-border px-1 py-0.5">↑↓</kbd> navigate</span>
          <span><kbd className="rounded border border-border px-1 py-0.5">↵</kbd> select</span>
          <span><kbd className="rounded border border-border px-1 py-0.5">⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
