import { base, id, ok } from "../base";
import { z } from "zod";
import { taskChangesSchema, taskInputSchema } from "../../tasks";

export const tasksContract = {
  create: base
    .route({ method: "POST", path: "/internal/tasks" })
    .input(taskInputSchema)
    .output(z.object({ id: z.string() })),
  update: base
    .route({ method: "POST", path: "/internal/tasks/{taskId}" })
    .input(taskChangesSchema.extend({ taskId: id }))
    .output(ok),
  remove: base
    .route({ method: "POST", path: "/internal/tasks/{taskId}/delete" })
    .input(z.object({ taskId: id }))
    .output(ok),
  /** Hand the task to its teammate in a new chat. */
  start: base
    .route({ method: "POST", path: "/internal/tasks/{taskId}/start" })
    .input(z.object({ taskId: id }))
    .output(z.object({ chatId: z.string().nullable() })),
};
