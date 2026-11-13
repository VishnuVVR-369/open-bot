import type { Feature } from "../../core/feature";
import { errorMessage, type Logger } from "../../logger";
import type { AccountAccess } from "./access";
import type { AccountActions } from "./actions";

/**
 * Your accounts' background work: the account actions you approved, carried out and drained at
 * shutdown, and keeping their sign-ins alive.
 */
export function integrationsFeature(
  services: {
    actions: Pick<AccountActions, "start" | "stop" | "idle" | "kick">;
    access: Pick<AccountAccess, "keepAlive">;
  },
  log: Pick<Logger, "warn">,
): Feature<"accounts"> {
  const { actions, access } = services;
  return {
    name: "integrations",
    async start(runtime) {
      actions.start();
      runtime.add("account actions", async () => {
        actions.stop();
        await actions.idle();
      });
      const keepAlive = () =>
        void access
          .keepAlive()
          .catch((error: unknown) =>
            log.warn("account keep-alive failed", { error: errorMessage(error) }),
          );
      runtime.after("first account keep-alive", 60_000, keepAlive);
      runtime.every("account keep-alive", 12 * 60 * 60_000, keepAlive);
    },
    signals: {
      accounts: () => actions.kick(),
    },
  };
}
