import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <TooltipProvider delayDuration={300}>
      <Outlet />
      <Toaster
        richColors
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "font-sans border border-white/10 backdrop-blur-xl shadow-2xl",
          },
        }}
      />
    </TooltipProvider>
  ),
});
