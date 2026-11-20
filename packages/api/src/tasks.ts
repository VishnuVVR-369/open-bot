import { creatorSchema, taskStatusSchema } from "@open-bot/domain";
import { z } from "zod";
import { id } from "./base";

/** A new task, as the owner or a teammate writes it. */
export const taskInputSchema = z.object({
  title: z.string(),
  notes: z.string().optional(),
  ownerTeammateId: id.nullable().optional(),
  dueOn: z.string().nullable().optional(),
});

/** What can change about a task; left-out fields stay as they are. */
export const taskChangesSchema = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  status: taskStatusSchema.optional(),
  ownerTeammateId: id.nullable().optional(),
  dueOn: z.string().nullable().optional(),
  position: z.number().finite().optional(),
});

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
