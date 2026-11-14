import { router, usePathname } from "expo-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import ShareIntent from "../../../modules/share-intent";
import type { SharedText } from "./share";

/** A share from another app, with an id of its own so sharing the same thing twice is two shares. */
export interface Share extends SharedText {
  id: number;
}

/**
 * The latest share from another app. It's only ever replaced, never consumed: the share screen
 * shows whatever is latest, and the app opens that screen once per share (see `shouldOpenShare`).
 * Keeping it that simple means nothing here changes while React renders or while listeners run.
 */
let latest: Share | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

export const shareInbox = {
  put(shared: SharedText) {
    latest = { id: nextId++, text: shared.text, subject: shared.subject };
    for (const listener of [...listeners]) listener();
  },
  latest: (): Share | null => latest,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The latest share, kept current while the screen is open. */
export function useLatestShare(): Share | null {
  return useSyncExternalStore(shareInbox.subscribe, shareInbox.latest);
}

/**
 * Whether to open the share screen for `share`: once per share, once the app is ready for it
 * (signed in, past the lock), and not when it's already showing, since it shows the latest itself.
 */
export function shouldOpenShare(
  share: Share | null,
  opened: number,
  ready: boolean,
  pathname: string,
): boolean {
  return Boolean(share && share.id !== opened && ready && pathname !== "/share");
}

/** Collects shares from Android (the one the app opened with, and any later) and opens the share screen when `ready`. */
export function useIncomingShares(ready: boolean) {
  useEffect(() => {
    if (!ShareIntent) return;
    const first = ShareIntent.take();
    if (first) shareInbox.put({ text: first.text, subject: first.subject ?? null });
    const subscription = ShareIntent.addListener("share", (share) =>
      shareInbox.put({ text: share.text, subject: share.subject ?? null }),
    );
    return () => subscription.remove();
  }, []);

  const share = useLatestShare();
  const pathname = usePathname();
  // The last share the screen was opened for (or was already showing when it came).
  const opened = useRef(0);
  useEffect(() => {
    if (!share || !ready) return;
    if (shouldOpenShare(share, opened.current, ready, pathname)) router.push("/share");
    opened.current = share.id;
  }, [share, ready, pathname]);
}
