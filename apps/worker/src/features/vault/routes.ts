import { os } from "../../core/rpc";
import type { VaultService } from "./service";

const ok = { ok: true } as const;

/** The vault procedures in the worker's internal API. */
export function vaultRoutes(vault: VaultService) {
  return {
    save: os.vault.save.handler(({ input }) => vault.saveItem(input)),
    remove: os.vault.remove.handler(async ({ input }) => {
      await vault.removeItem(input.itemId);
      return ok;
    }),
  };
}
