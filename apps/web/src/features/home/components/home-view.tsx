"use client";

import { greeting, plural } from "@open-bot/chat-core";
import { format } from "date-fns";
import { useSyncExternalStore } from "react";
import { ComputerOffline, ComputerPanel, useComputer } from "@/features/computer";
import { Briefing } from "./briefing";
import { useAppState } from "@/features/app-shell";
import { teammateActivity, isComputerOnline } from "@/lib/status";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NeedsYou } from "./needs-you";
import { Suggestions } from "./suggestions";
import { ProfileNudge } from "./profile-nudge";
import { Teammates } from "./teammates";
import { ComingUp } from "./coming-up";
import { RecentPages } from "./recent-pages";
import { Activity } from "./activity";

/** The minute it is in the browser. Null while rendering on the server, whose clock and time zone aren't the reader's. */
function subscribeMinute(onChange: () => void) {
  const timer = setInterval(onChange, 30_000);
  return () => clearInterval(timer);
}
function useMinute(): number | null {
  return useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / 60_000),
    () => null,
  );
}

/**
 * The line under the greeting, from the real state: how many things need you (each take over
 * request and each approval), then whether work is moving. While the computer is offline nothing
 * moves, and the line says so rather than counting anyone as working.
 */
export function teamSummary(
  state: Pick<AppState, "teammates" | "computer" | "pendingApprovals" | "takeoverRequests">,
): string {
  const online = isComputerOnline(state);
  const things = state.takeoverRequests.length + state.pendingApprovals;
  const needs = things > 0 ? `${plural(things, "thing needs", "things need")} you` : null;
  if (!online) {
    const busy = state.teammates.some((teammate) => teammate.activeRun);
    const paused = busy
      ? "Work is paused until the computer is back."
      : "Your teammates pick up again when the computer is back.";
    return needs ? `${needs}. ${paused}` : paused;
  }
  const working = state.teammates.filter(
    (teammate) => teammateActivity(teammate) === "working",
  ).length;
  if (needs && working)
    return `${needs}, and ${plural(working, "teammate is", "teammates are")} working.`;
  if (needs) return `${needs}.`;
  if (working) return `${plural(working, "teammate is", "teammates are")} working right now.`;
  return "Your teammates are ready when you are.";
}

export function HomeView() {
  const { data: state } = useAppState();
  const { online } = useComputer();
  // While the computer is offline it is one short card, so its column narrows.
  const offline = Boolean(state) && !online;
  const minute = useMinute();
  const now = minute === null ? null : new Date(minute * 60_000);
  const teammateIds = state?.teammates.map((teammate) => teammate.id) ?? [];
  const teammateNames = state?.teammates.map((teammate) => teammate.name) ?? [];
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "mx-auto grid w-full max-w-[1400px] gap-10 px-5 py-8 sm:px-10 sm:py-12 xl:gap-12",
          offline
            ? "xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
            : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]",
        )}
      >
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex flex-col gap-1.5">
            <p className="h-[18px] text-[13px] font-medium text-muted-foreground">
              {now && format(now, "EEEE, MMMM d")}
            </p>
            <h1 className="text-[30px] leading-tight font-semibold">
              {now && state ? (
                greeting(state.user.name, now.getHours())
              ) : (
                // Holds the line's height until the browser knows what time it is.
                <span className="invisible">Welcome</span>
              )}
            </h1>
            <p className="min-h-[22px] text-[14.5px] text-pretty text-muted-foreground">
              {state && teamSummary(state)}
            </p>
          </div>
          {/* Where the side column falls below, the offline notice stays up top. */}
          {offline && teammateIds.length > 0 && (
            <ComputerOffline teammateNames={teammateNames} className="-mt-2 xl:hidden" />
          )}
          {/* The suggestion sits right under what needs you, apart from it. */}
          <div className="flex flex-col gap-2 empty:hidden">
            <NeedsYou />
            <Suggestions />
          </div>
          <Briefing />
          <ProfileNudge />
          <Teammates />
          {!offline && <Activity />}
        </div>
        <div className="flex min-w-0 flex-col gap-8 xl:self-start">
          {/* Takeover requests are already in "Needs you", so the panel leaves them out. */}
          <ComputerPanel
            teammateIds={teammateIds}
            showRequests={false}
            className={offline ? "max-xl:hidden" : undefined}
          />
          <ComingUp now={minute === null ? null : minute * 60_000} />
          <RecentPages />
          {/* The offline card is short, so recent activity fills the side column instead. */}
          {offline && <Activity />}
        </div>
      </div>
    </div>
  );
}
