import "server-only";
import { os } from "@/lib/server/api/rpc";
import { worker } from "@/lib/server/worker";
import { listVaultItems } from "./queries";

/**
 * Logins and cards, as the browser and the phone ask (`contract.vault`). The worker owns the
 * writes: it encrypts a secret when it saves it, and never sends one back.
 */
export function vaultRoutes() {
  return {
    list: os.vault.list.handler(() => listVaultItems()),
    save: os.vault.save.handler(({ input }) => worker.vault.save(input)),
    remove: os.vault.remove.handler(({ input }) => worker.vault.remove({ itemId: input.itemId })),
  };
}
