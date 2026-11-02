/** The open-bot this app talks to. The worker's address always comes from the server. */
export const APP_URL = (
  process.env.EXPO_PUBLIC_APP_URL ?? "https://openbot.up.railway.app"
).replace(/\/+$/, "");

/** The app's deep link scheme (`openbot://`), which is also its origin for sign-in. */
export const SCHEME = "openbot";
