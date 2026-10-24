"use client";

import { useSyncExternalStore } from "react";
import { plainText } from "@/lib/utils";

/** Reads replies aloud with the browser's own voices. One reply at a time, across the app. */

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

const supported = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** Markdown as something to say: each line its own sentence, so lists get their pauses. */
export function speakable(markdown: string): string {
  return markdown
    .split(/\n+/)
    .map((line) => plainText(line))
    .filter(Boolean)
    .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

/** The reply being read, if any. */
export function readingNow(): string | null {
  return speaking;
}

export function stopReading() {
  if (!supported()) return;
  window.speechSynthesis.cancel();
  set(null);
}

/** Starts reading `markdown` as `id`, stopping whatever was being read. */
export function readAloud(id: string, markdown: string) {
  if (!supported()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(speakable(markdown));
  utterance.lang = navigator.language || "en-US";
  const done = () => {
    if (speaking === id) set(null);
  };
  utterance.onend = done;
  utterance.onerror = done;
  set(id);
  window.speechSynthesis.speak(utterance);
}

/** Whether the browser can read aloud, and which reply it's reading. */
export function useReadAloud(): { supported: boolean; speaking: string | null } {
  const canSpeak = useSyncExternalStore(subscribe, supported, () => false);
  const current = useSyncExternalStore(
    subscribe,
    () => speaking,
    () => null,
  );
  return { supported: canSpeak, speaking: current };
}
