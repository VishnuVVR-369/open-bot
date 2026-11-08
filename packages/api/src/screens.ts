import { z } from "zod";
import {
  computerLifecycleSchema,
  leaseHolderSchema,
  screenOperationSchema,
  typeOnScreenSchema,
} from "@open-bot/domain";
import { botSummarySchema } from "./views";

export { screenOperationSchema, typeOnScreenSchema };
export const screenFrameSchema = z.object({ artifactId: z.string(), at: z.string() });
export type ScreenFrame = z.infer<typeof screenFrameSchema>;

export const screenViewSchema = z.object({
  id: z.string(),
  bot: botSummarySchema,
  online: z.boolean(),
  lifecycle: computerLifecycleSchema.nullable().optional(),
  running: z.boolean(),
  lease: leaseHolderSchema,
  requests: z.array(
    z.object({ id: z.string(), reason: z.string().nullable(), createdAt: z.string() }),
  ),
  /**
   * The last screenshot the teammate took of this screen, to show (dimmed, as "Last seen") while
   * the computer is offline. Open it at `/api/artifacts/<artifactId>`. Null if there is none.
   */
  lastFrame: screenFrameSchema.nullable(),
});
export type ScreenView = z.infer<typeof screenViewSchema>;
