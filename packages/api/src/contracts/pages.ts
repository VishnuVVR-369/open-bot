import { pageThemeSchema } from "@open-bot/domain";
import { z } from "zod";
import { base, id, ok } from "../base";
import { pageDetailSchema, pageLinkSchema, pageSummarySchema } from "../views";

export const pagesContract = {
  /** Every page, pinned first, then the most recently updated. */
  list: base.output(z.array(pageSummarySchema)),
  /** Pages whose title, summary or text has the words, newest first. */
  search: base.input(z.object({ query: z.string().max(200) })).output(z.array(pageSummarySchema)),
  get: base.input(z.object({ pageId: id })).output(pageDetailSchema),
  /**
   * An address that shows a version for the next few minutes, on the pages origin (never the
   * app's). `ask` offers "Ask about this" on selected text; see `parsePageAskMessage`.
   */
  open: base
    .input(
      z.object({
        versionId: id,
        theme: pageThemeSchema.optional(),
        ask: z.boolean().optional(),
      }),
    )
    .output(pageLinkSchema),
  pin: base.input(z.object({ pageId: id, pinned: z.boolean() })).output(ok),
  /** Delete a page and every version of it. */
  remove: base.input(z.object({ pageId: id })).output(ok),
};
