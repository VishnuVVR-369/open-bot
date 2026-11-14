import { z } from "zod";
import { egressStatusSchema } from "./egress";
import { skillSummarySchema } from "./skills";
import {
  activityItemSchema,
  teammateSummarySchema,
  briefingItemSchema,
  chatSummarySchema,
  takeoverRequestSchema,
} from "./views";
import { codexStatusSchema, workerStatusSchema } from "./worker/views";

/**
 * The snapshots every screen starts from. Both the web app's shell (`appStateSchema`) and Home
 * (`homeSchema`) include what needs you (`attentionSchema`), read by one query, so a badge on the
 * web and on the phone can't disagree.
 */

/** What needs you: approvals, screens to take over, suggested instructions, unread news. */
export const attentionSchema = z.object({
  pendingApprovals: z.number().int().nonnegative(),
  takeoverRequests: z.array(takeoverRequestSchema),
  /** Teammates that suggested new instructions, waiting for you on the web. */
  proposals: z.array(z.object({ id: z.string(), teammateId: z.string() })),
  unreadNotifications: z.number().int().nonnegative(),
});
export type Attention = z.infer<typeof attentionSchema>;

/** Home: what needs you, what happened while you were away, and recent work. */
export const homeSchema = attentionSchema.extend({
  user: z.object({ name: z.string() }),
  /** Finished since `awaySince`, newest first; empty without it. */
  briefing: z.array(briefingItemSchema),
  activity: z.array(activityItemSchema),
});
export type Home = z.infer<typeof homeSchema>;

/** The worker and the computer, as the status bar shows them. */
export const computerViewSchema = workerStatusSchema.shape.computer.extend({
  /** False while the worker is unreachable; everything below is then a guess. */
  workerOnline: z.boolean(),
  egress: egressStatusSchema,
});
export type ComputerView = z.infer<typeof computerViewSchema>;

/** What the web app's shell shows on every screen: your team, chats, the computer, and badges. */
export const appStateSchema = attentionSchema.extend({
  user: z.object({ name: z.string(), email: z.string() }),
  /** Your timezone, for schedules and the teammates' sense of time. */
  timezone: z.string(),
  teammates: z.array(teammateSummarySchema),
  chats: z.array(chatSummarySchema),
  skills: z.array(skillSummarySchema),
  computer: computerViewSchema,
  /** The ChatGPT account, or null while the worker is unreachable. */
  codex: codexStatusSchema.nullable(),
  /** Screens you have control of right now. */
  activeTakeovers: z.array(
    z.object({ id: z.string(), screenId: z.string(), startedAt: z.string().nullable() }),
  ),
});
export type AppState = z.infer<typeof appStateSchema>;
