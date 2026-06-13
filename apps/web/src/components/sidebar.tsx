import { Link, useMatchRoute } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { Server, LogOut, Users, List, Clock, Shield, LayoutDashboard, CloudCog, Terminal } from "lucide-react";

interface User {
  id: string;
  name: string;
  email: string;
  role?: string | null;
}

interface SidebarProps {
  user: User;
}

const nav = [
  { to: "/" as const, label: "Dashboard", icon: LayoutDashboard },
  { to: "/servers" as const, label: "Servers", icon: Server },
  { to: "/lookups" as const, label: "Lookups", icon: List, roles: ["admin", "editor"] },
  { to: "/ssh" as const, label: "SSH Terminal", icon: Terminal, roles: ["admin"] },
  { to: "/users" as const, label: "Users", icon: Users, roles: ["admin"] },
  { to: "/audit" as const, label: "Audit Log", icon: Clock, roles: ["admin"] },
  { to: "/security" as const, label: "Security", icon: Shield },
];

export function Sidebar({ user }: SidebarProps) {
  const matchRoute = useMatchRoute();
  const role = user.role ?? "viewer";

  async function handleLogout() {
    await authClient.signOut();
    window.location.href = "/login";
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar/90 backdrop-blur-xl">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
        <div className="flex items-center justify-center rounded-lg bg-primary/90 w-8 h-8 text-primary-foreground shadow-lg shadow-primary/30 shrink-0">
          <CloudCog className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold tracking-tight bg-linear-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
          Server Inventory
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 p-2 pt-3">
        {nav
          .filter((item) => !item.roles || item.roles.includes(role))
          .map(({ to, label, icon: Icon }) => {
            const active = !!matchRoute({ to, fuzzy: true });
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-150",
                  active
                    ? "bg-primary/15 text-primary font-medium glow-blue"
                    : "text-sidebar-foreground/70 hover:bg-white/6 hover:text-sidebar-foreground",
                )}
              >
                <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                {label}
              </Link>
            );
          })}
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-3 space-y-2">
        <div className="flex items-center gap-2 px-1">
          <ThemeToggle />
          <div className="flex-1 min-w-0">
            <p className="truncate text-xs font-medium text-sidebar-foreground">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground capitalize">{role}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </aside>
  );
}
