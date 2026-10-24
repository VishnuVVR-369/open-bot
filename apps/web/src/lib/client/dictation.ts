"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** The parts of the Web Speech API dictation uses. */
interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionClass(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  // Electron has the API but not the speech service behind it, so it always fails there.
  if (/\bElectron\//.test(navigator.userAgent)) return null;
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const noop = () => () => {};

/** Plain words for why dictation stopped, or null when there's nothing to say. */
function problem(error: string): string | null {
  switch (error) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Allow the microphone for this site to dictate.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Dictation needs the browser's speech service, which isn't available here. Try Chrome or Safari.";
    default:
      return "Dictation stopped unexpectedly.";
  }
}

/**
 * Speak instead of type. While listening, `onText` gets the full text: what was there when you
 * started, then what you said, including words still being recognized.
 */
export function useDictation({
  onText,
  onError,
}: {
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const supported = useSyncExternalStore(
    noop,
    () => recognitionClass() !== null,
    () => false,
  );
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const handlers = useRef({ onText, onError });
  useEffect(() => {
    handlers.current = { onText, onError };
  });

  const stop = useCallback(() => recognition.current?.stop(), []);

  /** Stop without touching the text, like when you send the message. */
  const cancel = useCallback(() => {
    const instance = recognition.current;
    if (!instance) return;
    instance.onresult = null;
    instance.onerror = null;
    instance.onend = null;
    recognition.current = null;
    setListening(false);
    instance.abort();
  }, []);

  const start = useCallback((before: string) => {
    const Recognition = recognitionClass();
    if (!Recognition || recognition.current) return;
    const instance = new Recognition();
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = navigator.language || "en-US";
    const base = before && !/\s$/.test(before) ? `${before} ` : before;
    let spoken = "";
    instance.onresult = (event) => {
      // Rebuilt from every result each time: a finished phrase can be reported again.
      let interim = "";
      spoken = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        if (result.isFinal) spoken += result[0].transcript;
        else interim += result[0].transcript;
      }
      handlers.current.onText(`${base}${spoken}${interim}`.replace(/ {2,}/g, " "));
    };
    instance.onerror = (event) => {
      const message = problem(event.error);
      if (message) handlers.current.onError(message);
    };
    instance.onend = () => {
      recognition.current = null;
      setListening(false);
      // Drop words that were never confirmed.
      handlers.current.onText(`${base}${spoken}`.replace(/ {2,}/g, " ").trimEnd());
    };
    recognition.current = instance;
    setListening(true);
    instance.start();
  }, []);

  // Stop listening when the composer goes away.
  useEffect(() => cancel, [cancel]);

  return { supported, listening, start, stop, cancel };
}
