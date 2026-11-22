import "server-only";
import { os } from "@/lib/server/api/rpc";
import { worker } from "@/lib/server/worker";
import { ApiError } from "@/lib/server/api/errors";
import { getTask, listTasks } from "./queries";

/** The task board, as the browser and the phone ask (`contract.tasks`). The worker owns the writes. */
export function taskRoutes() {
  return {
    list: os.tasks.list.handler(() => listTasks()),
    get: os.tasks.get.handler(async ({ input }) => {
      const task = await getTask(input.taskId);
      if (!task) throw new ApiError("NOT_FOUND", "That task was deleted.");
      return task;
    }),
    create: os.tasks.create.handler(({ input }) => worker.tasks.create(input)),
    update: os.tasks.update.handler(({ input }) => worker.tasks.update(input)),
    move: os.tasks.move.handler(({ input }) => worker.tasks.move(input)),
    remove: os.tasks.remove.handler(({ input }) => worker.tasks.remove(input)),
    start: os.tasks.start.handler(({ input }) => worker.tasks.start(input)),
  };
}
