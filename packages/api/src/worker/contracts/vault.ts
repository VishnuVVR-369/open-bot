import { base, id, ok } from "../base";
import { z } from "zod";
import { vaultItemInputSchema, vaultItemPatchSchema } from "../../vault";

export const vaultContract = {
  /** Save a login or card: a new one, or with `id`, a change to one. Its secret is encrypted. */
  save: base
    .route({ method: "POST", path: "/internal/vault" })
    .input(vaultItemInputSchema)
    .output(z.object({ id: z.string() })),
  /** Change only the fields given of a saved login or card. */
  patch: base
    .route({ method: "POST", path: "/internal/vault/{itemId}/patch" })
    .input(vaultItemPatchSchema)
    .output(z.object({ id: z.string() })),
  remove: base
    .route({ method: "POST", path: "/internal/vault/{itemId}/delete" })
    .input(z.object({ itemId: id }))
    .output(ok),
};
