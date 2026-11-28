import { requireNativeModule } from "expo";

/**
 * Keeps the app out of screenshots, screen recordings, casting and the recent apps preview
 * (Android's FLAG_SECURE), drawn natively (`SecureScreen.kt`). It needs no permission and listens
 * for nothing: the app counts the screens that ask (`src/lib/capture-hold.ts`).
 */
interface SecureScreen {
  /** Turns it on for the app's window, and any window it opens until `allow`, rotation included. */
  prevent(): void;
  /** Turns it off again. */
  allow(): void;
}
export default requireNativeModule<SecureScreen>("OpenBotSecureScreen");
