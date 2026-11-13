import { base, id, ok } from "../base";
import { z } from "zod";
import { vaultItemInputSchema } from "../../vault";

export const vaultContract = {
  /** Save a login or card: a new one, or with `id`, a change to one. Its secret is encrypted. */
  save: base
    .route({ method: "POST", path: "/internal/vault" })
    .input(vaultItemInputSchema)
    .output(z.object({ id: z.string() })),
  remove: base
    .route({ method: "POST", path: "/internal/vault/{itemId}/delete" })
    .input(z.object({ itemId: id }))
    .output(ok),
};
