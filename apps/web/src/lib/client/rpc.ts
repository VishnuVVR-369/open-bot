import { createApiClient } from "@open-bot/api";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

/**
 * The API (`@open-bot/api`) as the browser calls it, with your session cookie. The phone calls the
 * same procedures; the web app's routes only serve streams and files.
 */
export const api = createApiClient({ appUrl: () => window.location.origin });

/**
 * Query options and keys for every procedure: `useQuery(orpc.tasks.list.queryOptions())`, and
 * `orpc.tasks.key()` to refresh everything under `tasks`. Keys are procedure paths, so the realtime
 * refresh map (`APP_EVENT_REFRESHES`) names them directly.
 */
export const orpc = createTanstackQueryUtils(api);
