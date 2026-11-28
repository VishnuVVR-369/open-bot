import { allowScreenCaptureAsync, preventScreenCaptureAsync } from "expo-screen-capture";
import { useEffect } from "react";
import { holdScreenCapture } from "./capture-hold";
import { ALLOW_SCREEN_CAPTURE } from "./config";

const KEY = "sensitive";
const change = {
  prevent: () => preventScreenCaptureAsync(KEY),
  allow: () => allowScreenCaptureAsync(KEY),
};

/**
 * Keeps what this screen shows out of screenshots, screen recordings, casting and the recent apps
 * preview (Android's FLAG_SECURE) for as long as it's mounted. Several screens can hold it at once:
 * it lifts when the last one goes, so an editor closing over the vault doesn't uncover the vault.
 */
export function useNoScreenCapture() {
  useEffect(() => (ALLOW_SCREEN_CAPTURE ? undefined : holdScreenCapture(change)), []);
}
