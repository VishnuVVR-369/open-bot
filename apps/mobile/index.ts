// Background handlers must be registered before the app, so a notification or one of its buttons
// can be handled while the app is closed (Android starts a headless JS task for it).
import "./src/push/background";
import "expo-router/entry";
import { E2E_NOTIFICATIONS } from "./src/lib/config";

// Local UI tests exercise Android notification actions without production Firebase credentials.
// This module is excluded from release bundles and does not bypass authentication.
if (__DEV__ && E2E_NOTIFICATIONS) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./src/testing/notifications");
}
