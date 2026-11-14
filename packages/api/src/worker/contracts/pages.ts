import { base, computer, id, ok } from "../base";
import { isPageSourcePath, MAX_PAGE_SUMMARY, MAX_PAGE_TITLE } from "@open-bot/domain";
import { z } from "zod";

export const pagesContract = {
  /** Pin or unpin a page. */
  pin: base
    .route({ method: "POST", path: "/internal/pages/{pageId}/pin" })
    .input(z.object({ pageId: id, pinned: z.boolean() }))
    .output(ok),
  /** Delete a page and its versions. */
  remove: base
    .route({ method: "POST", path: "/internal/pages/{pageId}/delete" })
    .input(z.object({ pageId: id }))
    .output(ok),
  /**
   * Check and publish a page from a file on the computer, the way publish_page does but
   * outside a run: for setting up pages, and for tests that need a real one.
   */
  publish: computer
    .route({ method: "POST", path: "/internal/pages/publish" })
    .input(
      z.object({
        botId: id,
        chatId: id.nullable().default(null),
        path: z
          .string()
          .refine(isPageSourcePath, "Use an .html file in a workspace or the shared folder."),
        title: z.string().trim().min(1).max(MAX_PAGE_TITLE),
        summary: z.string().max(MAX_PAGE_SUMMARY).default(""),
        note: z.string().max(1000).default(""),
        pageId: id.optional(),
      }),
    )
    .output(
      z.object({
        pageId: z.string(),
        versionId: z.string(),
        version: z.number().int(),
        warnings: z.array(z.string()),
      }),
    ),
};
