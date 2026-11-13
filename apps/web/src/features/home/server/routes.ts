import "server-only";
import { os } from "@/lib/server/api/rpc";
import { getHome } from "./queries";

/** Home, as the browser and the phone ask (`contract.home`). */
export function homeRoutes() {
  return {
    get: os.home.get.handler(({ input, context }) => getHome(context.user, input)),
  };
}
