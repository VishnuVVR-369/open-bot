import { speakable } from "@open-bot/domain";
import * as Speech from "expo-speech";
import { useSyncExternalStore } from "react";

/** Reads replies aloud with the phone's voice. One reply at a time, across the app. */

let speaking: string | null = null;
const listeners = new Set<() => void>();

function set(id: string | null) {
  speaking = id;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readingNow(): string | null {
  return speaking;
}

export function stopReading() {
  void Speech.stop();
  set(null);
}

/** Starts reading `markdown` as `id`, stopping whatever was being read. */
export function readAloud(id: string, markdown: string) {
  void Speech.stop();
  const done = () => {
    if (speaking === id) set(null);
  };
  set(id);
  Speech.speak(speakable(markdown), { onDone: done, onStopped: done, onError: done });
}

/** The reply being read, if any. */
export function useReading(): string | null {
  return useSyncExternalStore(subscribe, () => speaking);
}
