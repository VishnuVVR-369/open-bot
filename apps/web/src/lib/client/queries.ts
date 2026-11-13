"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import type { AppState } from "../types";
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

export function useNotifications(enabled = true) {
  return useQuery(orpc.notifications.list.queryOptions({ enabled }));
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

export function useProfile() {
  return useQuery(orpc.profile.get.queryOptions());
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

/** False while the computer (the worker) is offline, so views skip requests that would fail. */
export function useComputerOnline(): boolean | undefined {
  const { data: state } = useAppState();
  return state?.computer.workerOnline;
}
