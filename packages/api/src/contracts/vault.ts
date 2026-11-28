import { z } from "zod";
import { base, id, ok } from "../base";
import { vaultItemInputSchema, vaultItemPatchSchema, vaultItemViewSchema } from "../vault";

export const vaultContract = {
  /** Logins and cards, without their secrets. */
  list: base.output(z.array(vaultItemViewSchema)),
  /** Save a login or card. Its secret is encrypted on the server and never sent back. */
  save: base.input(vaultItemInputSchema).output(z.object({ id: z.string() })),
  /**
   * Change a saved login or card: only the fields given, so an edit made elsewhere meanwhile to
   * another field stays. Secrets left out or empty keep what's saved.
   */
  patch: base.input(vaultItemPatchSchema).output(z.object({ id: z.string() })),
  remove: base.input(z.object({ itemId: id })).output(ok),
};
