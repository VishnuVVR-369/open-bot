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
  fetch: (request, init) => {
    const controller = new AbortController();
    const existing = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    const abort = () => controller.abort();
    if (existing?.aborted) controller.abort();
    else existing?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 300_000);
    return fetch(request, { ...init, signal: controller.signal, credentials: "omit" }).finally(
      () => {
        clearTimeout(timeout);
        existing?.removeEventListener("abort", abort);
      },
    );
  },
});
