import type { ScreenView } from "@open-bot/api";
import { isOwnerLease } from "@open-bot/shared";

/**
 * What a screen is doing, from your side: what to say about it and which action comes first.
 * `using` means a teammate is driving it; `awake` means it's on and nobody is.
 */
export type ScreenState =
  | { kind: "controlling"; paused: boolean }
  | { kind: "offline" }
  | { kind: "needs-you"; reason: string | null; requestId: string }
  | { kind: "asleep" }
  | { kind: "using"; botName: string }
  | { kind: "awake" };

export function screenState(screen: ScreenView): ScreenState {
  if (isOwnerLease(screen.lease))
    return { kind: "controlling", paused: screen.lease.pausedForSafety === true };
  if (!screen.online) return { kind: "offline" };
  const request = screen.requests[0];
  if (request) return { kind: "needs-you", reason: request.reason, requestId: request.id };
  if (!screen.running) return { kind: "asleep" };
  if (screen.lease?.kind === "run") return { kind: "using", botName: screen.lease.botName };
  return { kind: "awake" };
}

export function screenStatus(screen: ScreenView): string {
  const lifecycle = screen.lifecycle;
  if (lifecycle?.enabled) {
    if (lifecycle.error) return "Computer error — tap Wake to retry";
    if (lifecycle.phase === "waking") return "Waking computer…";
    if (lifecycle.phase === "quiescing") return "Computer going idle";
    if (lifecycle.phase === "idle") return "Computer idle";
  }
  const state = screenState(screen);
  switch (state.kind) {
    case "controlling":
      return state.paused ? "Paused for safety" : "You're in control";
    case "offline":
      return "Computer offline";
    case "needs-you":
      return "Needs you to take over";
    case "asleep":
      return "Asleep";
    case "using":
      return `${state.botName} is using it`;
    case "awake":
      return "Awake";
  }
}

/** Screens that need you first, then the one you hold, then the rest in their usual order. */
export function sortScreens(screens: readonly ScreenView[]): ScreenView[] {
  const rank = (screen: ScreenView) => {
    const kind = screenState(screen).kind;
    return kind === "needs-you" ? 0 : kind === "controlling" ? 1 : 2;
  };
  return screens
    .map((screen, index) => ({ screen, index }))
    .sort((a, b) => rank(a.screen) - rank(b.screen) || a.index - b.index)
    .map(({ screen }) => screen);
}

export const screenHref = (id: string, takeoverId?: string, code = false) =>
  `/screens/${encodeURIComponent(id)}${takeoverId ? `?takeover=${encodeURIComponent(takeoverId)}${code ? "&code=1" : ""}` : ""}` as const;

/** Recover a lost send by status/cancellation, never by repeating input. */
export async function recoverCodeOperation<T>(
  id: string,
  get: (id: string) => Promise<T | null>,
  cancel: (id: string) => Promise<T>,
): Promise<T> {
  return (await get(id)) ?? (await cancel(id));
}
