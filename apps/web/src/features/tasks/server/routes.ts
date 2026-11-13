import "server-only";
import { os } from "@/lib/server/api/rpc";
import { worker } from "@/lib/server/worker";
import { listTasks } from "./queries";

/** The task board, as the browser and the phone ask (`contract.tasks`). The worker owns the writes. */
export function taskRoutes() {
  return {
    list: os.tasks.list.handler(() => listTasks()),
    create: os.tasks.create.handler(({ input }) => worker.tasks.create(input)),
    update: os.tasks.update.handler(({ input }) => worker.tasks.update(input)),
    remove: os.tasks.remove.handler(({ input }) => worker.tasks.remove(input)),
    start: os.tasks.start.handler(({ input }) => worker.tasks.start(input)),
  };
}
