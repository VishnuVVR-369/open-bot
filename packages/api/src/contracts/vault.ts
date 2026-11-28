import { z } from "zod";
import { base, id, ok } from "../base";
import {
  vaultItemCreateSchema,
  vaultItemInputSchema,
  vaultItemPatchSchema,
  vaultItemViewSchema,
} from "../vault";

export const vaultContract = {
  /** Logins and cards, without their secrets. */
  list: base.output(z.array(vaultItemViewSchema)),
  /**
   * Add a login or card under `id`, a fresh id the client made and keeps for retries. Sending it
   * again after an answer that never came answers with that item (`created: false`) instead of
   * adding another. An id already naming a different item fails with `CONFLICT`. Its secret is
   * encrypted on the server and never sent back.
   */
  create: base
    .input(vaultItemCreateSchema)
    .output(z.object({ id: z.string(), created: z.boolean() })),
  /**
   * Save a login or card: with `id`, the whole item again; without, a new one with no retry
   * safety, for apps from before `create`. Its secret is encrypted on the server.
   */
  save: base.input(vaultItemInputSchema).output(z.object({ id: z.string() })),
  /**
   * Change a saved login or card: only the fields given, so an edit made elsewhere meanwhile to
   * another field stays. Secrets left out or empty keep what's saved.
   */
  patch: base.input(vaultItemPatchSchema).output(z.object({ id: z.string() })),
  remove: base.input(z.object({ itemId: id })).output(ok),
};
