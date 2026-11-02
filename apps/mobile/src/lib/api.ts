import { createApiClient } from "@open-bot/api";
import { sessionCookie } from "./auth";
import { APP_URL } from "./config";

/** The typed open-bot API, as you. */
export const api = createApiClient({
  appUrl: APP_URL,
  headers: async () => {
    const cookie = await sessionCookie();
    const headers: Record<string, string> = cookie ? { cookie } : {};
    return headers;
  },
  // The cookie goes in the header; letting fetch manage cookies too can send a stale one.
  fetch: (request, init) => fetch(request, { ...init, credentials: "omit" }),
});
