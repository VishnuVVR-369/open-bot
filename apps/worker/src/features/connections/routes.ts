import { os } from "../../core/rpc";
import type { ConnectionService } from "./service";

const ok = { ok: true } as const;

/** The connections procedures in the worker's internal API. */
export function connectionsRoutes(connections: ConnectionService) {
  return {
    save: os.connections.save.handler(({ input }) => connections.saveMcp(input)),
    setEnabled: os.connections.setEnabled.handler(async ({ input }) => {
      await connections.setEnabled(input.connectionId, input.enabled);
      return ok;
    }),
    remove: os.connections.remove.handler(({ input }) => connections.remove(input.connectionId)),
    updateAccount: os.connections.updateAccount.handler(({ input }) =>
      connections.updateAccount(input),
    ),
    linkAccount: os.connections.linkAccount.handler(({ input }) => connections.linkAccount(input)),
    test: os.connections.test.handler(({ input }) => connections.test(input.connectionId)),
  };
}
