import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { getLocales } from "expo-localization";
import { useCallback, useRef, useState } from "react";

/**
 * Dictation with Android's speech recognition: what you say is added to what's already written,
 * live while you speak.
 */
export function useDictation({
  onText,
  onError,
}: {
  /** The whole text: what was there when you started, then what you've said. */
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const base = useRef("");
  const finalSoFar = useRef("");

  const join = (spoken: string) => {
    const start = base.current;
    if (!spoken) return start;
    return start && !/\s$/.test(start) ? `${start} ${spoken}` : `${start}${spoken}`;
  };

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";
    if (event.isFinal) {
      finalSoFar.current = [finalSoFar.current, transcript].filter(Boolean).join(" ");
      onText(join(finalSoFar.current));
    } else onText(join([finalSoFar.current, transcript].filter(Boolean).join(" ")));
  });
  useSpeechRecognitionEvent("error", (event) => {
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
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        onError("Allow open-bot to use the microphone to dictate.");
        return;
      }
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        onError("This phone has no speech recognition.");
        return;
      }
      base.current = current;
      finalSoFar.current = "";
      ExpoSpeechRecognitionModule.start({
        lang: getLocales()[0]?.languageTag ?? "en-US",
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
      });
    },
    [onError],
  );

  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);
  // Cleanup is registered before listening begins. It mustn't capture that render's state.
  const cancel = useCallback(() => ExpoSpeechRecognitionModule.abort(), []);

  return { listening, start, stop, cancel };
}
