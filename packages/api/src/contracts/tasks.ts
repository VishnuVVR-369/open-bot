import { z } from "zod";
import { base, id, ok } from "../base";
import { taskChangesSchema, taskInputSchema, taskMoveSchema, taskViewSchema } from "../tasks";

export const tasksContract = {
  /** The team's board, in board order. */
  list: base.output(z.array(taskViewSchema)),
  /** One task, finished long ago or not; `NOT_FOUND` once it's deleted. */
  get: base.input(z.object({ taskId: id })).output(taskViewSchema),
  create: base.input(taskInputSchema).output(z.object({ id: z.string() })),
  update: base.input(taskChangesSchema.extend({ taskId: id })).output(ok),
  /** To another column, or another place in its own, in one change. */
  move: base.input(taskMoveSchema).output(ok),
  remove: base.input(z.object({ taskId: id })).output(ok),
  /** Hand the task to its teammate in a new chat. */
  start: base.input(z.object({ taskId: id })).output(z.object({ chatId: z.string().nullable() })),
};
