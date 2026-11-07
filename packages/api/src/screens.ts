import { z } from "zod";
import {
  computerLifecycleSchema,
  screenOperationSchema,
  typeOnScreenSchema,
} from "@open-bot/shared";
import { botSummarySchema } from "./views";

export { screenOperationSchema, typeOnScreenSchema };
export const ownerLeaseSchema = z.object({
  kind: z.enum(["user", "user-code"]),
  since: z.string(),
  lastInputAt: z.string(),
  pausedForSafety: z.boolean().optional(),
});
export const screenViewSchema = z.object({
  id: z.string(),
  bot: botSummarySchema,
  online: z.boolean(),
  lifecycle: computerLifecycleSchema.nullable().optional(),
  running: z.boolean(),
  lease: z
    .union([
      ownerLeaseSchema,
      z.object({
        kind: z.literal("run"),
        runId: z.string(),
        botId: z.string(),
        botName: z.string(),
        since: z.string(),
        lastActionAt: z.string(),
      }),
    ])
    .nullable(),
  requests: z.array(
    z.object({ id: z.string(), reason: z.string().nullable(), createdAt: z.string() }),
  ),
});
export type ScreenView = z.infer<typeof screenViewSchema>;
