import { isOwnerLease } from "@open-bot/domain";
import type { QueryClient } from "@tanstack/react-query";
import type { AppState } from "@/lib/types";
import { orpc } from "./rpc";

/** The app state as it is once you hand a screen back. */
export function releaseScreen(state: AppState, screenId: string): AppState {
  const health = state.computer.health;
  return {
    ...state,
    activeTakeovers: state.activeTakeovers.filter((takeover) => takeover.screenId !== screenId),
    computer: {
      ...state.computer,
      health: health && {
        ...health,
        screens: health.screens.map((screen) =>
          screen.id === screenId && isOwnerLease(screen.lease)
            ? { ...screen, lease: null }
            : screen,
        ),
      },
    },
  };
}

/**
 * Lets go of a screen in the cached app state before the server hears about it, so the screen
 * stops taking your input and its connection closes cleanly. A refresh in flight would put the
 * old lease back, so it is cancelled first.
 */
export async function releaseScreenNow(queryClient: QueryClient, screenId: string) {
  await queryClient.cancelQueries({ queryKey: orpc.app.state.key() });
  // An exact key: `.key()` is only a prefix, and writing to it would make a second entry.
  queryClient.setQueryData<AppState>(orpc.app.state.queryKey(), (state) =>
    state ? releaseScreen(state, screenId) : state,
  );
}
