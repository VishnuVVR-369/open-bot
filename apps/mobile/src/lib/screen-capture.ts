import SecureScreen from "../../modules/secure-screen";
import { ALLOW_SCREEN_CAPTURE } from "./config";

/**
 * Keeps the app out of screenshots, screen recordings, casting and the recent apps preview
 * (Android's FLAG_SECURE, drawn by `modules/secure-screen`) until `allowScreenCapture`. The vault
 * counts the screens that need it (`createVaultScreens`). A development build with
 * `EXPO_PUBLIC_ALLOW_SCREEN_CAPTURE=1` skips it, for UI review screenshots.
 */
export function preventScreenCapture() {
  if (!ALLOW_SCREEN_CAPTURE) SecureScreen.prevent();
}

export function allowScreenCapture() {
  if (!ALLOW_SCREEN_CAPTURE) SecureScreen.allow();
}
