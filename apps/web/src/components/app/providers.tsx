"use client";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePresence } from "@/lib/client/presence";
import { isUnauthorized } from "@/lib/client/errors";
import { goToSignIn } from "@/lib/client/sign-in";
import { RealtimeProvider } from "@/lib/client/realtime";
import { orpc } from "@/lib/client/rpc";
import type { AppState } from "@/lib/types";

export function Providers({ initial, children }: { initial: AppState; children: ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      queryCache: new QueryCache({
        // The session is gone (signed out elsewhere, or expired): sign in again, then come back.
        onError: (error) => {
          if (isUnauthorized(error)) goToSignIn();
        },
      }),
      defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 } },
    });
    // Seed the app state the server already loaded, so nothing flashes empty on first paint.
    client.setQueryData(orpc.app.state.queryKey(), initial);
    return client;
  });
  usePresence();
  return (
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider>
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </RealtimeProvider>
    </QueryClientProvider>
  );
}
