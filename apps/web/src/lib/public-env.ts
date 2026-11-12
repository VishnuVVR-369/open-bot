/**
 * The web app's build-time values, inlined into the server and the browser alike (`env` in
 * `apps/web/next.config.ts`, or a `NEXT_PUBLIC_*` name). Each is read by its literal name, which is
 * what Next.js replaces. Server-only settings are in `lib/server/env.ts`.
 */
export const publicEnv = {
  /** Which deploy this code is from, or null in a build that names none, such as `next dev`. */
  deploymentId: process.env.OPENBOT_DEPLOYMENT_ID || null,
};
