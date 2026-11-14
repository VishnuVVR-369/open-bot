import { z } from "zod";
import { base, id, ok } from "../base";
import { taskChangesSchema, taskInputSchema, taskViewSchema } from "../tasks";

export const tasksContract = {
  /** The team's board, in board order. */
  list: base.output(z.array(taskViewSchema)),
  create: base.input(taskInputSchema).output(z.object({ id: z.string() })),
  update: base.input(taskChangesSchema.extend({ taskId: id })).output(ok),
  remove: base.input(z.object({ taskId: id })).output(ok),
  /** Hand the task to its teammate in a new chat. */
  start: base.input(z.object({ taskId: id })).output(z.object({ chatId: z.string().nullable() })),
};
