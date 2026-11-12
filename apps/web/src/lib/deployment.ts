import { publicEnv } from "./public-env";

/**
 * Which deploy this code is from: the commit Railway built, or `NEXT_DEPLOYMENT_ID`, inlined at
 * build time (`apps/web/next.config.ts`) into the server and the browser alike. Null in a build
 * that names none, such as `next dev`, where tabs are never told to reload.
 */
export const DEPLOYMENT_ID: string | null = publicEnv.deploymentId;

/** True when the server runs a different deploy than this tab, so the tab's code is out of date. */
export function isOutdated(serverDeployment: unknown, own: string | null = DEPLOYMENT_ID): boolean {
  return (
    typeof serverDeployment === "string" && serverDeployment !== "" && serverDeployment !== own
  );
}
