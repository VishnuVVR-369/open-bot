import "server-only";
import { os } from "@/lib/server/api/rpc";
import { getAppState } from "./queries";

export function appRoutes() {
  return {
    state: os.app.state.handler(({ context }) =>
      getAppState({ name: context.user.name, email: context.user.email }),
    ),
  };
}
