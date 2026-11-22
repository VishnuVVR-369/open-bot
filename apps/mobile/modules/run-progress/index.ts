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
   * This sign-in's registration id, made on the first call after sign-in. The app sends it with
   * its FCM token, and pushes carry it; a push for any other registration is dropped. Call it only
   * while signed in.
   */
  registration(): string;
  /**
   * On sign-out: forgets the registration, so no push for the account you left draws anything,
   * and removes every progress notification with what the phone kept to draw them.
   */
  reset(): void;
}
export default requireNativeModule<RunProgress>("OpenBotRunProgress");
