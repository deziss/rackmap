import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async () => {
    const { data: session } = await authClient.getSession();
    if (!session?.user) {
      throw redirect({ to: "/login" });
    }
    return { session };
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { session } = Route.useRouteContext();
  return (
    <div className="mesh-bg flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar user={session.user} />
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
      <CommandPalette userRole={session.user.role ?? "viewer"} />
    </div>
  );
}
