/** The desktop app's settings, the only place it reads the environment. */

/** Where the web app lives. Locally the Next.js dev server; in production the deployed app. */
export const APP_URL = process.env.OPEN_BOT_URL ?? "https://openbot.up.railway.app";
