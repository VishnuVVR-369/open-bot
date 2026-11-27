import {
  memoryEditSchema,
  memoryInputSchema,
  memoryItemSchema,
  memoryReferenceSchema,
  memoryRevisionSchema,
  memorySaveOutcomeSchema,
} from "@open-bot/domain";
import { z } from "zod";
import { base, id, ok } from "../base";
import { memoryRunRefSchema } from "../memory";

export const memoryContract = {
  /** Memories you can see and edit, matching `query`: one teammate's, or everyone's with null. */
  list: base
    .input(z.object({ teammateId: id.nullable(), query: z.string().max(200) }))
    .output(z.array(memoryItemSchema)),
  /** One memory you can see, by id; `NOT_FOUND` once it's forgotten. */
  get: base.input(z.object({ memoryId: id })).output(memoryItemSchema),
  /** Every revision of a memory, newest first. */
  history: base.input(z.object({ memoryId: id })).output(z.array(memoryRevisionSchema)),
  /** The memories a reply was given. */
  forRun: base.input(z.object({ runId: id })).output(z.array(memoryRunRefSchema)),
  /**
   * Save a memory you wrote. Saying what's already saved confirms it instead of adding another;
   * `saveOutcome` says which happened. `id` is a fresh id for this save, kept for retries: the
   * memory is saved under it, so sending again after an answer that never came answers with that
   * memory as it is now (`created`) instead of adding another, or with `STATE_CONFLICT` if it was
   * forgotten since. An id already naming a different memory fails with `CONFLICT`. It's optional
   * for clients from before it.
   */
  create: base
    .input(memoryInputSchema.extend({ id: id.optional() }))
    .output(memoryItemSchema.extend({ saveOutcome: memorySaveOutcomeSchema })),
  /**
   * Change a memory. `expectedRevision` is the one you saw: a change made since fails with
   * `STATE_CONFLICT` instead of being overwritten. The same holds for `forget`, `confirm` and
   * `restore`.
   */
  update: base.input(memoryEditSchema).output(memoryItemSchema),
  forget: base.input(memoryReferenceSchema).output(ok),
  /** Make a teammate's suggested memory a real one. */
  confirm: base.input(memoryReferenceSchema).output(memoryItemSchema),
  /** Make an earlier revision the current one, as a new revision. */
  restore: base
    .input(memoryReferenceSchema.extend({ revision: z.number().int().positive() }))
    .output(memoryItemSchema),
};
