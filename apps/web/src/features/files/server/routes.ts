import "server-only";
import { os } from "@/lib/server/api/rpc";
import { worker } from "@/lib/server/worker";

/**
 * Files on the computer, as the browser and the phone ask (`contract.files`). The worker reads
 * and changes them on the computer; bytes go through the routes in `app/api/files`.
 */
export function fileRoutes() {
  return {
    list: os.files.list.handler(({ input }) => worker.files.list({ path: input.path })),
    remove: os.files.remove.handler(({ input }) => worker.files.remove(input)),
  };
}
