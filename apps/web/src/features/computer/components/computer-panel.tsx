"use client";

import { useRef } from "react";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { type ScreenHandle } from "./screen-view";
import { useComputer, useFollowedScreen } from "../hooks";
import { ComputerOffline } from "./screen-status";
import { ScreenFrame } from "./screen-glass";
import { ScreenControls } from "./screen-controls";
import { ScreenPicker } from "./screen-picker";

/** The computer as a panel: the bots' screens, one at a time, with their controls. */
export function ComputerPanel({
  botIds,
  initial,
  loading = false,
  showRequests = true,
  className,
}: {
  /** Whose screens to offer. The panel follows whichever is busy. */
  botIds: string[];
  initial?: AppState;
  /** Whose screens they are isn't known yet. */
  loading?: boolean;
  /** Show takeover requests under the screen. Off where the page already lists them. */
  showRequests?: boolean;
  className?: string;
}) {
  const handleRef = useRef<ScreenHandle | null>(null);
  const { state, online } = useComputer(initial);
  const { screenId, pick } = useFollowedScreen(botIds, initial);
  if (state && !online && botIds.length > 0) {
    const names = botIds.flatMap((id) => state.bots.find((bot) => bot.id === id)?.name ?? []);
    return <ComputerOffline botNames={names} className={className} />;
  }
  if (!screenId) {
    return (
      <section
        aria-label="Computer"
        aria-busy={loading || !state}
        className={cn(
          "flex aspect-[16/11] flex-col items-center justify-center gap-1.5 rounded-[22px] bg-bezel px-8 text-center text-bezel-foreground/70",
          className,
        )}
      >
        {!loading && state && (
          <>
            <span className="text-[14px] font-medium text-bezel-foreground">No screens yet</span>
            <span className="text-[12.5px]">
              Every teammate gets their own screen on the shared computer.
            </span>
          </>
        )}
      </section>
    );
  }
  return (
    <section aria-label="Computer" className={cn("flex flex-col gap-3", className)}>
      <ScreenPicker botIds={botIds} value={screenId} onChange={pick} initial={initial} />
      <ScreenFrame screenId={screenId} initial={initial} handleRef={handleRef} expand />
      <ScreenControls
        screenId={screenId}
        initial={initial}
        handleRef={handleRef}
        expand={false}
        showRequests={showRequests}
      />
    </section>
  );
}
