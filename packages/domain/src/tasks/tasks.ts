import { z } from "zod";

/** Where a task on the team's board stands. */
export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = (typeof TASK_STATUSES)[number];
