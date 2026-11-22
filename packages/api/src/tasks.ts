import { creatorSchema, taskPlacementSchema, taskStatusSchema } from "@open-bot/domain";
import { z } from "zod";
import { id } from "./base";

/** A new task, as the owner or a teammate writes it. */
export const taskInputSchema = z.object({
  title: z.string(),
  notes: z.string().optional(),
  ownerTeammateId: id.nullable().optional(),
  dueOn: z.string().nullable().optional(),
});

/**
 * What can change about a task; left-out fields stay as they are. A new status puts it at the end
 * of that column; `move` puts it anywhere.
 */
export const taskChangesSchema = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  status: taskStatusSchema.optional(),
  ownerTeammateId: id.nullable().optional(),
  dueOn: z.string().nullable().optional(),
});

/**
 * What a client from before `move` sends as `update`'s `position`: where it dropped the task. It
 * stays accepted while such a client can still be open (a browser tab loaded before the deploy),
 * and is forwarded to the worker, which places the task before the first one past it.
 */
export const legacyTaskPositionSchema = z.number().finite().optional();

/**
 * Asking a task's owner to start on it. `startId` is a fresh id for this ask, kept for retries:
 * asking again with it, after an answer that never came, answers the same instead of asking
 * twice. `expectedOwnerId` is the teammate the button named; if the task has gone to someone
 * else meanwhile, it's refused rather than asking them. Both are optional for clients from
 * before them.
 */
export const taskStartSchema = z.object({
  taskId: id,
  startId: id.optional(),
  expectedOwnerId: id.optional(),
});

/** A task moved to a column, at the end or next to a task there. The worker picks its position. */
export const taskMoveSchema = z.object({
  taskId: id,
  status: taskStatusSchema,
  placement: taskPlacementSchema,
});
export type TaskMoveInput = z.infer<typeof taskMoveSchema>;

/** A task on the team's board. */
export const taskViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  status: taskStatusSchema,
  ownerTeammateId: z.string().nullable(),
  dueOn: z.string().nullable(),
  position: z.number(),
  createdBy: creatorSchema,
  createdByTeammateId: z.string().nullable(),
  /** The chat where the owner was last asked to work on it. */
  chatId: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TaskView = z.infer<typeof taskViewSchema>;
