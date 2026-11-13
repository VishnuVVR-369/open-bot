import { os } from "../../core/rpc";
import type { TaskService } from "./service";

const ok = { ok: true } as const;

/** The board as the web app changes it (`workerContract.tasks`). */
export function taskRoutes(tasks: TaskService) {
  return {
    create: os.tasks.create.handler(async ({ input }) => ({
      id: (await tasks.create({ ...input, createdBy: "user" })).id,
    })),
    update: os.tasks.update.handler(async ({ input: { taskId, ...patch } }) => {
      await tasks.update(taskId, patch);
      return ok;
    }),
    remove: os.tasks.remove.handler(async ({ input }) => {
      await tasks.remove(input.taskId);
      return ok;
    }),
    start: os.tasks.start.handler(async ({ input }) => ({
      chatId: (await tasks.start(input.taskId, null)).chatId,
    })),
  };
}
