import { ALWAYS_REFRESHED, APP_EVENT_REFRESHES, type ProcedurePath } from "@open-bot/api";
import type { AppEvent } from "@open-bot/domain";
import type { QueryClient } from "@tanstack/react-query";

/**
 * What an app event from the stream refreshes in the browser's cache. Queries are cached under
 * their procedure path (`orpc`'s keys are `[path, { input, type }]`), so a path matches every query
 * of that procedure, or of every procedure in that namespace.
 */

function refresh(queryClient: QueryClient, paths: readonly ProcedurePath[]): Promise<void> {
  return Promise.all(paths.map((path) => queryClient.invalidateQueries({ queryKey: [path] }))).then(
    () => undefined,
  );
}

/** Refresh what the event says is stale, besides the snapshots (see `refreshSnapshots`). */
export function refreshForAppEvent(queryClient: QueryClient, event: AppEvent): Promise<void> {
  return refresh(queryClient, APP_EVENT_REFRESHES[event.type]);
}

/** Refresh the shell's state and Home, which every event (and every reconnect) may change. */
export function refreshSnapshots(queryClient: QueryClient): Promise<void> {
  return refresh(queryClient, ALWAYS_REFRESHED);
}

/**
 * After the stream was down: refresh everything any event could have refreshed, since those events
 * are gone. An open chat replays its own events from its cursor, so it isn't refetched.
 */
export function refreshAfterOutage(queryClient: QueryClient): Promise<void> {
  return refresh(queryClient, [...ALWAYS_REFRESHED, ...Object.values(APP_EVENT_REFRESHES).flat()]);
}
