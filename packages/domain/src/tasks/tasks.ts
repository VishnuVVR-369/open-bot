import { z } from "zod";

/** Where a task on the team's board stands. */
export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Where a moved task goes in its new column: at the end, or just before or after another task
 * there. The worker turns it into a position, so clients never do position math of their own.
 */
export const taskPlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("end") }),
  z.object({ kind: z.literal("before"), taskId: z.string().uuid() }),
  z.object({ kind: z.literal("after"), taskId: z.string().uuid() }),
]);
export type TaskPlacement = z.infer<typeof taskPlacementSchema>;
