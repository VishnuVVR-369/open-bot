import { requireNativeModule } from "expo";

/** A running teammate's progress notification, drawn natively (`RunProgress.kt`). */
interface RunProgress {
  /** Handles a `run-progress` push's data; false when it isn't one. */
  handle(data: Record<string, string>): boolean;
  /** The run's result was shown: its progress notification goes for good. */
  endRun(runId: string): void;
  /** The chat on screen while the app is in front, or null; its runs show no notification. */
  setVisibleChat(chatId: string | null): void;
  /**
   * The registration id of this sign-in (`sessionId`, your session's id), made on the first call
   * for it. The app sends it with its FCM token, and pushes carry it; a push for any other
   * registration is dropped. A call for another session first forgets the one before, as
   * `reset()` does. Call it only while signed in.
   */
  registration(sessionId: string): string;
  /** Whether the phone holds a sign-in's registration: signed in, and not signed out since. */
  signedIn(): boolean;
  /**
   * On sign-out: forgets the registration, so no push for the account you left draws anything,
   * and removes every progress notification with what the phone kept to draw them.
   */
  reset(): void;
}
export default requireNativeModule<RunProgress>("OpenBotRunProgress");
