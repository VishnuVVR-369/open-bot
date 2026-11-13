import { os } from "../../core/rpc";
import type { PageService } from "./service";

const ok = { ok: true } as const;

/** Pages as the web app pins, deletes and publishes them (`workerContract.pages`). */
export function pageRoutes(pages: PageService) {
  return {
    pin: os.pages.pin.handler(async ({ input }) => {
      await pages.pin(input.pageId, input.pinned);
      return ok;
    }),
    remove: os.pages.remove.handler(async ({ input }) => {
      await pages.remove(input.pageId);
      return ok;
    }),
    publish: os.pages.publish.handler(async ({ input }) => {
      const { page, version, check } = await pages.checkAndPublish({ ...input, runId: null });
      return {
        pageId: page.id,
        versionId: version.id,
        version: version.number,
        warnings: check.issues.map((issue) => issue.message),
      };
    }),
  };
}
