import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { worker } from "../worker";

/** Logins and cards. The worker saves them (it owns the vault, see packages/db/src/owners.ts). */

type Inputs = ApiInputs["vault"];

/** Save a login or card. The worker encrypts the secret, which is never sent back. */
export async function saveVaultItem(input: Inputs["save"]): Promise<{ id: string }> {
  return worker.vault.save(input);
}

export async function removeVaultItem({ itemId }: Inputs["remove"]): Promise<{ ok: true }> {
  return worker.vault.remove({ itemId });
}
