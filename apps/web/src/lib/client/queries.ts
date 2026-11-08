"use client";

import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import type { AppState } from "../types";
import { isNotFound } from "./errors";
import { orpc } from "./rpc";

/**
 * Reads the browser makes, one hook per procedure of the API (`@open-bot/api`). Each is cached
 * under its procedure path, so `queryClient.invalidateQueries({ queryKey: orpc.tasks.key() })`
 * refreshes it, and app events refresh it by `APP_EVENT_REFRESHES`.
 */

/** The shell's state: team, chats, the computer and badges. Seeded by the server on first paint. */
export function useAppState(initial?: AppState) {
  return useQuery(
    orpc.app.state.queryOptions({
      initialData: initial,
      // The worker's and the computer's health have no events of their own.
      refetchInterval: 15_000,
    }),
  );
}

/** Home: recent work, and what finished since `awaySince` (a time in milliseconds) if given. */
export function useHome(awaySince: number | null) {
  return useQuery(
    orpc.home.get.queryOptions({
      input: { awaySince: awaySince === null ? null : new Date(awaySince).toISOString() },
      // Recent work stays on screen while the briefing starts or ends.
      placeholderData: keepPreviousData,
    }),
  );
}

export function useNotifications(enabled = true) {
  return useQuery(orpc.notifications.list.queryOptions({ enabled }));
}

export function useApprovals() {
  return useQuery(orpc.approvals.list.queryOptions());
}

export function useSchedules() {
  return useQuery(orpc.schedules.list.queryOptions());
}

/** A schedule's recent runs, loaded when you open its history. */
export function useScheduleRuns(scheduleId: string, enabled: boolean) {
  return useQuery(
    orpc.schedules.runs.queryOptions({ input: enabled ? { scheduleId } : skipToken }),
  );
}

export function useTriggers() {
  return useQuery(orpc.triggers.list.queryOptions());
}

/** A watch's or webhook's recent runs, loaded when you open its history. */
export function useTriggerRuns(triggerId: string, enabled: boolean) {
  return useQuery(orpc.triggers.runs.queryOptions({ input: enabled ? { triggerId } : skipToken }));
}

export function useSkills() {
  return useQuery(orpc.skills.list.queryOptions());
}

export function useTasks() {
  return useQuery(orpc.tasks.list.queryOptions());
}

export function useLessons(botId: string) {
  return useQuery(orpc.teammates.lessons.queryOptions({ input: { botId } }));
}

export function useProfile() {
  return useQuery(orpc.profile.get.queryOptions());
}

export function useVault() {
  return useQuery(orpc.vault.list.queryOptions());
}

export function useSpending(botId: string) {
  return useQuery(orpc.teammates.spending.queryOptions({ input: { botId } }));
}

export function useConnections() {
  return useQuery(orpc.connections.list.queryOptions());
}

export function useAccountsSetup() {
  return useQuery(orpc.accounts.setup.queryOptions());
}

export function usePages() {
  return useQuery(orpc.pages.list.queryOptions());
}

export function usePage(pageId: string) {
  return useQuery(
    orpc.pages.get.queryOptions({
      input: { pageId },
      retry: (count, error) => !isNotFound(error) && count < 2,
    }),
  );
}

/**
 * Where to show a version. Links work for a few minutes, so a page reopened later gets a new one.
 * Not cached with the page lists: the `pages` event never refreshes it.
 */
export function usePageLink(versionId: string | null, theme: "light" | "dark", ask: boolean) {
  return useQuery(
    orpc.pages.open.queryOptions({
      input: versionId === null ? skipToken : { versionId, theme, ask },
      // Loaded once into the frame, which keeps working after the link expires. Coming back to it
      // later (another theme and back, or the page again) gets a new link once this one is near its end.
      staleTime: (query) =>
        query.state.data
          ? Math.max(0, Date.parse(query.state.data.expiresAt) - Date.now() - 60_000)
          : 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
  );
}

/** False while the computer (the worker) is offline, so views skip requests that would fail. */
export function useComputerOnline(): boolean | undefined {
  const { data: state } = useAppState();
  return state?.computer.workerOnline;
}
