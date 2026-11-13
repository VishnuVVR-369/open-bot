import "server-only";
import { os } from "@/lib/server/api/rpc";
import { getPage, listPages, openPage, pinPage, removePage, searchPages } from "./service";

/** Pages teammates publish, as the browser and the phone ask (`contract.pages`). */
export function pageRoutes() {
  return {
    list: os.pages.list.handler(() => listPages()),
    search: os.pages.search.handler(({ input }) => searchPages(input.query)),
    get: os.pages.get.handler(({ input }) => getPage(input.pageId)),
    open: os.pages.open.handler(({ input }) => openPage(input)),
    pin: os.pages.pin.handler(({ input }) => pinPage(input)),
    remove: os.pages.remove.handler(({ input }) => removePage(input)),
  };
}
