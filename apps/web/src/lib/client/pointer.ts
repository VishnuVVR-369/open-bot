import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * Whether the main pointer is a finger, as on a phone or tablet, where nothing can be hovered.
 * False while rendering on the server, which can't know.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
