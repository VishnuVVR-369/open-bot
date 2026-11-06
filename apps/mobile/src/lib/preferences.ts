import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";

/** How the app looks and feels on this phone. Kept on the phone, like the phone's own settings. */
export interface Preferences {
  appearance: "system" | "light" | "dark";
  haptics: boolean;
  /** Ask for a fingerprint when the app opens, and after five minutes away. */
  appLock: boolean;
}

const KEY = "openbot:preferences";
const DEFAULTS: Preferences = { appearance: "system", haptics: true, appLock: true };

let current: Preferences = DEFAULTS;
const listeners = new Set<() => void>();

function apply(preferences: Preferences) {
  Appearance.setColorScheme(
    preferences.appearance === "system" ? "unspecified" : preferences.appearance,
  );
}

/** Reads what was saved. Until it's read, the defaults apply (the system theme, haptics on). */
export async function loadPreferences(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    if (saved) current = { ...DEFAULTS, ...(JSON.parse(saved) as Partial<Preferences>) };
  } catch {
    // Unreadable: keep the defaults.
  }
  apply(current);
  for (const listener of listeners) listener();
}

export function getPreferences(): Preferences {
  return current;
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  current = { ...current, [key]: value };
  apply(current);
  for (const listener of listeners) listener();
  void AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
