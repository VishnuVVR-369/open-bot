"use client";

import { isOwnerLease, type LeaseHolder, type ScreenStatus } from "@open-bot/domain";
import { useState } from "react";
import { useAppState } from "@/features/app-shell";
import { isComputerOnline } from "@/lib/status";
import type { AppState, TeammateSummary, TakeoverRequestSummary } from "@/lib/types";

export type ScreenActivity = "you" | "working" | "idle" | "asleep" | "offline";

export interface ScreenInfo {
  teammate: TeammateSummary;
  status: ScreenStatus | null;
  lease: LeaseHolder;
  activity: ScreenActivity;
  requests: TakeoverRequestSummary[];
}

/** The computer and every teammate's screen on it. */
export function useComputer(initial?: AppState) {
  const { data } = useAppState(initial);
  const state = data ?? initial;
  const lifecycle = state?.computer.lifecycle;
  const online = isComputerOnline(state);
  const screens = state?.computer.health?.screens ?? [];
  const requests = state?.takeoverRequests ?? [];

  function screen(teammateId: string): ScreenInfo | null {
    const teammate = state?.teammates.find((b) => b.id === teammateId);
    if (!teammate) return null;
    const status = screens.find((s) => s.id === teammateId) ?? null;
    const lease = status?.lease ?? null;
    const activity: ScreenActivity = !online
      ? "offline"
      : isOwnerLease(lease)
        ? "you"
        : lease?.kind === "run"
          ? "working"
          : status?.state === "running"
            ? "idle"
            : "asleep";
    return {
      teammate,
      status,
      lease,
      activity,
      requests: requests.filter((request) => request.screenId === teammateId),
    };
  }

  const controlled = screens
    .filter((s) => isOwnerLease(s.lease))
    .map((s) => s.id)
    .filter((id) => state?.teammates.some((teammate) => teammate.id === id));

  return {
    state,
    lifecycle,
    online,
    workerOnline: state?.computer.workerOnline ?? false,
    egress: state?.computer.egress,
    requests,
    screens,
    screen,
    /** Screens you have control of. */
    controlled,
  };
}

/**
 * Which of these teammates' screens to show. It follows the action until you pick one:
 * a screen you control, then one a teammate asks you to take over, then the one most recently busy.
 */
export function useFollowedScreen(teammateIds: string[], initial?: AppState) {
  const { screen } = useComputer(initial);
  const [picked, setPicked] = useState<string | null>(null);
  const infos = teammateIds.map(screen).filter((info): info is ScreenInfo => info !== null);
  const valid = picked && infos.some((info) => info.teammate.id === picked) ? picked : null;
  const busiest = [...infos]
    .filter((info) => info.lease?.kind === "run")
    .sort((a, b) =>
      (b.lease?.kind === "run" ? b.lease.lastActionAt : "").localeCompare(
        a.lease?.kind === "run" ? a.lease.lastActionAt : "",
      ),
    )[0];
  const followed =
    infos.find((info) => info.activity === "you") ??
    infos.find((info) => info.requests.length > 0) ??
    busiest ??
    infos.find((info) => info.teammate.activeRun && info.teammate.activeRun.status !== "queued") ??
    infos.find((info) => info.activity === "idle") ??
    infos[0];
  return {
    screenId: valid ?? followed?.teammate.id ?? null,
    pick: setPicked,
    following: valid === null,
  };
}
