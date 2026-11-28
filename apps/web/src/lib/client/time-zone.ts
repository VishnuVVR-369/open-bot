import { viewerTimeZone } from "@open-bot/domain";
import { useSyncExternalStore } from "react";

// The zone doesn't change while a page is open in a way worth following.
const subscribe = () => () => {};

/**
 * The browser's own time zone, to say when a schedule's clock isn't yours. Null while rendering on
 * the server, which can't know it, so the page renders the same there and on its first paint.
 */
export function useViewerTimeZone(): string | null {
  return useSyncExternalStore(subscribe, viewerTimeZone, () => null);
}
