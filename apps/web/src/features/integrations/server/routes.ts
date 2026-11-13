import "server-only";
import { os } from "@/lib/server/api/rpc";
import {
  getAccountsSetup,
  getEmailStatus,
  listConnections,
  removeConnection,
  removeEmailToken,
  saveAccountConnection,
  saveConnection,
  saveEmailSettings,
  saveOAuthClient,
  setConnectionEnabled,
  startAccountConnect,
  testConnection,
} from "./service";

/**
 * Connections, accounts and email, as the browser and the phone ask (`contract.connections`,
 * `contract.accounts` and `contract.email`).
 */
export function integrationRoutes() {
  return {
    connections: {
      list: os.connections.list.handler(() => listConnections()),
      save: os.connections.save.handler(({ input }) => saveConnection(input)),
      setEnabled: os.connections.setEnabled.handler(({ input }) => setConnectionEnabled(input)),
      remove: os.connections.remove.handler(({ input }) => removeConnection(input)),
      test: os.connections.test.handler(({ input }) => testConnection(input)),
    },
    accounts: {
      setup: os.accounts.setup.handler(() => getAccountsSetup()),
      saveClient: os.accounts.saveClient.handler(({ input }) => saveOAuthClient(input)),
      connect: os.accounts.connect.handler(({ input, context }) =>
        startAccountConnect(input, context.sessionId),
      ),
      update: os.accounts.update.handler(({ input }) => saveAccountConnection(input)),
    },
    email: {
      status: os.email.status.handler(() => getEmailStatus()),
      save: os.email.save.handler(({ input }) => saveEmailSettings(input)),
      removeToken: os.email.removeToken.handler(() => removeEmailToken()),
    },
  };
}
