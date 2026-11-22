import { requireNativeModule } from "expo";

/** A running teammate's progress notification, drawn natively (`RunProgress.kt`). */
interface RunProgress {
  /** Handles a `run-progress` push's data; false when it isn't one. */
  handle(data: Record<string, string>): boolean;
  /** The run's result was shown: its progress notification goes for good. */
  endRun(runId: string): void;
  /** The chat on screen while the app is in front, or null; its runs show no notification. */
  setVisibleChat(chatId: string | null): void;
  /** On sign-out: every progress notification goes, with what the phone kept to draw them. */
  reset(): void;
}
export default requireNativeModule<RunProgress>("OpenBotRunProgress");
