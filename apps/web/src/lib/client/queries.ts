"use client";

import { useQuery } from "@tanstack/react-query";
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

export function useProfile() {
  return useQuery(orpc.profile.get.queryOptions());
}

/** False while the computer (the worker) is offline, so views skip requests that would fail. */
export function useComputerOnline(): boolean | undefined {
  const { data: state } = useAppState();
  return state?.computer.workerOnline;
}
