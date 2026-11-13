import { z } from "zod";
import { base, id, ok } from "../base";
import { vaultItemInputSchema, vaultItemViewSchema } from "../vault";

export const vaultContract = {
  /** Logins and cards, without their secrets. */
  list: base.output(z.array(vaultItemViewSchema)),
  /** Save a login or card. Its secret is encrypted on the server and never sent back. */
  save: base.input(vaultItemInputSchema).output(z.object({ id: z.string() })),
  remove: base.input(z.object({ itemId: id })).output(ok),
};
