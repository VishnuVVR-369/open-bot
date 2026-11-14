import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { getLocales } from "expo-localization";
import { useCallback, useEffect, useRef, useState } from "react";

// Android has one recognizer. Hidden, mounted composers must ignore its events.
let activeSession: { owner: object; accepting: boolean; ended: Promise<void> } | null = null;

/**
 * Dictation with Android's speech recognition: what you say is added to what's already written,
 * live while you speak.
 */
export function useDictation({
  onText,
  onError,
}: {
  /**
   * The whole text: what was there when you started, then what you've said, then any text added
   * after it meanwhile (`append`).
   */
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const owner = useRef({});
  const request = useRef(0);
  const base = useRef("");
  const finalSoFar = useRef("");
  /** Paragraphs added after what you're saying while you speak, like a reply a notification kept. */
  const after = useRef<string[]>([]);

  const join = (spoken: string) => {
    const start = base.current;
    const said = !spoken
      ? start
      : start && !/\s$/.test(start)
        ? `${start} ${spoken}`
        : `${start}${spoken}`;
    if (after.current.length === 0) return said;
    return [said.trimEnd(), ...after.current].filter(Boolean).join("\n\n");
  };

  useSpeechRecognitionEvent("start", () => {
    if (activeSession?.owner === owner.current && activeSession.accepting) setListening(true);
  });
  useSpeechRecognitionEvent("result", (event) => {
    if (activeSession?.owner !== owner.current || !activeSession.accepting) return;
    const transcript = event.results[0]?.transcript ?? "";
    if (event.isFinal) {
      finalSoFar.current = [finalSoFar.current, transcript].filter(Boolean).join(" ");
      onText(join(finalSoFar.current));
    } else onText(join([finalSoFar.current, transcript].filter(Boolean).join(" ")));
  });
  useSpeechRecognitionEvent("error", (event) => {
    if (activeSession?.owner !== owner.current || !activeSession.accepting) return;
    activeSession.accepting = false;
    setListening(false);
    // Nothing heard, or you stopped it: not worth a message.
    if (
      event.error === "no-speech" ||
      event.error === "aborted" ||
      event.error === "speech-timeout"
    )
      return;
    onError(
      event.error === "not-allowed"
        ? "Allow open-bot to use the microphone in Android's settings."
        : event.error === "network"
          ? "Dictation needs a connection on this phone."
          : "Dictation stopped. Try again.",
    );
  });

  const start = useCallback(
    async (current: string) => {
      const attempt = ++request.current;
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      // The permission prompt may finish after the composer has lost focus.
      if (attempt !== request.current) return;
      if (!permission.granted) {
        onError("Allow open-bot to use the microphone to dictate.");
        return;
      }
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        onError("This phone has no speech recognition.");
        return;
      }
      if (activeSession?.owner === owner.current && activeSession.accepting) return;
      // abort() ends asynchronously. Don't attribute its late events to the next composer.
      while (activeSession) {
        await activeSession.ended;
        if (attempt !== request.current) return;
      }
      base.current = current;
      finalSoFar.current = "";
      after.current = [];
      let end!: () => void;
      const session = {
        owner: owner.current,
        accepting: true,
        ended: new Promise<void>((resolve) => {
          end = resolve;
        }),
      };
      activeSession = session;
      // This listener outlives an unmounted composer until native teardown is complete.
      const subscription = ExpoSpeechRecognitionModule.addListener("end", () => {
        setListening(false);
        if (activeSession === session) activeSession = null;
        subscription.remove();
        end();
      });
      try {
        ExpoSpeechRecognitionModule.start({
          lang: getLocales()[0]?.languageTag ?? "en-US",
          interimResults: true,
          continuous: true,
          addsPunctuation: true,
        });
      } catch {
        activeSession = null;
        subscription.remove();
        end();
        onError("Dictation couldn't start. Try again.");
      }
    },
    [onError],
  );

  /**
   * Text added after what's in the box while you speak (a reply a notification kept): it stays
   * after what you say from now on, instead of being written over.
   */
  const append = useCallback((text: string) => {
    if (activeSession?.owner === owner.current && activeSession.accepting)
      after.current = [...after.current, text];
  }, []);

  const stop = useCallback(() => {
    if (activeSession?.owner === owner.current && activeSession.accepting)
      ExpoSpeechRecognitionModule.stop();
  }, []);
  // Cleanup is registered before listening begins. It mustn't capture that render's state.
  const cancel = useCallback(() => {
    request.current += 1;
    if (activeSession?.owner !== owner.current || !activeSession.accepting) return;
    activeSession.accepting = false;
    setListening(false);
    ExpoSpeechRecognitionModule.abort();
  }, []);
  useEffect(() => cancel, [cancel]);

  return { listening, start, stop, cancel, append };
}
