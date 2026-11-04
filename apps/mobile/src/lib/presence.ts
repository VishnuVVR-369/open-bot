import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

/**
 * When you were last looking at the app, so Home can say what happened while you were away. Kept
 * on the phone: being away means not looking at this app, which only the phone knows.
 */

/** How long you need to be gone for a briefing, as on the web. */
export const AWAY_MS = 15 * 60_000;
const HEARTBEAT_MS = 30_000;
const KEY = "openbot:presence";

export interface PresenceState {
  /** The last time the app was in front. */
  lastActive: number | null;
  /** The briefing's start, while there's one to show. */
  awaySince: number | null;
}

/** The app is in front at `now`. Coming back after a while away starts a briefing. */
export function touch(state: PresenceState, now: number): PresenceState {
  const away = state.lastActive !== null && now - state.lastActive >= AWAY_MS;
  return { lastActive: now, awaySince: away ? state.lastActive : state.awaySince };
}

export function dismiss(state: PresenceState): PresenceState {
  return { ...state, awaySince: null };
}

let state: PresenceState = { lastActive: null, awaySince: null };
let loaded = false;
const listeners = new Set<() => void>();

function set(next: PresenceState) {
  state = next;
  for (const listener of listeners) listener();
  void AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<PresenceState>) : {};
    state = {
      lastActive: typeof saved.lastActive === "number" ? saved.lastActive : null,
      awaySince: typeof saved.awaySince === "number" ? saved.awaySince : null,
    };
  } catch {
    // Nothing saved yet, or unreadable: start fresh.
  }
}

/** Notes that you're here while the app is in front. Mount once, while signed in. */
export function useTrackPresence(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const beat = () => {
      if (AppState.currentState === "active") set(touch(state, Date.now()));
    };
    void load().then(beat);
    timer = setInterval(beat, HEARTBEAT_MS);
    const subscription = AppState.addEventListener("change", (next) => {
      // Leaving counts as the last moment you were here.
      if (next === "active" || next === "background") set(touch(state, Date.now()));
    });
    return () => {
      if (timer) clearInterval(timer);
      subscription.remove();
    };
  }, [enabled]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** When the current briefing starts (ISO), or null when there's nothing to brief you on. */
export function usePresence(): { awaySince: string | null; dismiss: () => void } {
  const since = useSyncExternalStore(subscribe, () => state.awaySince);
  return {
    awaySince: since === null ? null : new Date(since).toISOString(),
    dismiss: () => set(dismiss(state)),
  };
}

/** Forget it all, on sign-out. */
export async function clearPresence() {
  state = { lastActive: null, awaySince: null };
  for (const listener of listeners) listener();
  await AsyncStorage.removeItem(KEY).catch(() => {});
}
