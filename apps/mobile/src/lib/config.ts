/**
 * The phone app's settings, the only place it reads the environment. Expo inlines each
 * `EXPO_PUBLIC_*` variable at build time, so each is read by its literal name.
 */

/** The open-bot this app talks to. The worker's address always comes from the server. */
export const APP_URL = (
  process.env.EXPO_PUBLIC_APP_URL ?? "https://openbot.up.railway.app"
).replace(/\/+$/, "");

/** The app's deep link scheme (`openbot://`), which is also its origin for sign-in. */
export const SCHEME = "openbot";

/**
 * Development builds for the local UI tests: open `openbot://?e2ePush=...` links as notifications,
 * without Firebase. Release builds leave out the module that does it (`__DEV__`).
 */
export const E2E_NOTIFICATIONS = process.env.EXPO_PUBLIC_E2E_NOTIFICATIONS === "1";
