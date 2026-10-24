"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * When you were last here, so Home can brief you on what happened while you were away. Kept in
 * the browser: being away means not looking at the app, which only the browser knows.
 */
const ACTIVE_KEY = "open-bot:last-active";
const SINCE_KEY = "open-bot:briefing-since";

/** How long you need to be gone for a briefing. */
export const AWAY_MS = 15 * 60_000;
const HEARTBEAT_MS = 30_000;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function touch() {
  const now = Date.now();
  const last = Number(localStorage.getItem(ACTIVE_KEY) ?? 0);
  if (last > 0 && now - last >= AWAY_MS) {
    localStorage.setItem(SINCE_KEY, String(last));
    emit();
  }
  localStorage.setItem(ACTIVE_KEY, String(now));
}

/** Notes that you're here while the app is visible. Mount once. */
export function usePresence() {
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState === "visible") touch();
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    // Another tab can start or dismiss a briefing.
    const onStorage = (event: StorageEvent) => {
      if (event.key === SINCE_KEY) emit();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** When the briefing starts, or null when there's nothing to brief you on. */
export function useBriefingSince(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const since = Number(localStorage.getItem(SINCE_KEY) ?? 0);
      return since > 0 ? since : null;
    },
    () => null,
  );
}

export function dismissBriefing() {
  localStorage.removeItem(SINCE_KEY);
  emit();
}
