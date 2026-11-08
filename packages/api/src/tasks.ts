import { z } from "zod";

/** A task on the team's board. */
export const taskViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  ownerBotId: z.string().nullable(),
  dueOn: z.string().nullable(),
  position: z.number(),
  createdBy: z.enum(["user", "bot"]),
  createdByBotId: z.string().nullable(),
  /** The chat where the owner was last asked to work on it. */
  chatId: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TaskView = z.infer<typeof taskViewSchema>;
