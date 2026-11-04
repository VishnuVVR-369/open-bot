import type { ScreenView } from "@open-bot/api";
import { isOwnerLease } from "@open-bot/shared";

export function screenStatus(screen: ScreenView): string {
  if (isOwnerLease(screen.lease))
    return screen.lease.pausedForSafety ? "Paused for safety" : "You have control";
  if (!screen.online) return "Computer offline";
  if (screen.requests.length) return "Needs you to take over";
  if (!screen.running) return "Asleep";
  if (screen.lease?.kind === "run") return `${screen.lease.botName} is working`;
  return "Idle";
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
