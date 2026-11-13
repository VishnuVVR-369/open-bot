"use client";

import { CloudOff } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isOffline } from "@/lib/client/errors";

/** A section that needs the computer while it's offline: calm, and it recovers by itself. */
export function OfflineNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-3 rounded-xl border bg-subtle/60 px-4 py-3.5"
      data-testid="offline-note"
    >
      <CloudOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-0.5">
        <span className="text-[14px] font-medium">The computer is offline</span>
        <span className="text-[13px] text-muted-foreground">{children}</span>
      </div>
    </div>
  );
}

/** Keep checking a query that failed because the computer is offline, so it recovers by itself. */
export const OFFLINE_RETRY = {
  retry: (failures: number, error: Error) => !isOffline(error) && failures < 2,
  refetchInterval: (query: { state: { status: string } }) =>
    query.state.status === "error" ? 15_000 : false,
} as const;

/** A section that couldn't load for another reason: say so, and offer to try again. */
export function SectionError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[13.5px]">
      <span className="text-muted-foreground">Couldn&apos;t load this. {error.message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Loading, offline, or failed: what a section shows before its data arrives. */
export function SectionState({
  error,
  onRetry,
  offline,
}: {
  error: Error | null;
  onRetry: () => void;
  /** What the section is for, said while the computer is offline. */
  offline?: ReactNode;
}) {
  if (!error) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (offline && isOffline(error)) return <OfflineNote>{offline}</OfflineNote>;
  return <SectionError error={error} onRetry={onRetry} />;
}
