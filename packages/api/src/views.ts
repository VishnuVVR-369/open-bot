import type { RunTimelineState } from "@open-bot/shared";
import { z } from "zod";

/**
 * What the API returns, as zod schemas. The web app's view types for these come from here, so the
 * web and the phone always read the same shapes.
 */

const isoDate = z.string();

export const runStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
]);

export const autonomySchema = z.enum(["full", "risky", "everything"]);

export const botSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
  color: z.string(),
  emoji: z.string(),
  autonomy: autonomySchema,
  isPrimary: z.boolean(),
  /** The bot's direct chat. */
  directChatId: z.string().nullable(),
  activeRun: z
    .object({
      id: z.string(),
      chatId: z.string(),
      status: runStatusSchema,
      waitingFor: z.enum(["approval", "takeover"]).nullable(),
    })
    .nullable(),
});
export type BotSummary = z.infer<typeof botSummarySchema>;

export const chatKindSchema = z.enum(["direct", "group", "scheduled", "helper", "inbox"]);

export const chatSummarySchema = z.object({
  id: z.string(),
  kind: chatKindSchema,
  title: z.string(),
  botId: z.string().nullable(),
  memberIds: z.array(z.string()),
  lastActivityAt: isoDate,
  active: z.boolean(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const attachmentSchema = z.object({
  name: z.string().max(255),
  path: z.string().max(1000),
  mime: z.string().max(255),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const messageViewSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "system"]),
  text: z.string(),
  attachments: z.array(attachmentSchema),
  mentions: z.array(z.string()),
  steeredRunId: z.string().nullable(),
  /** Your feedback on this reply, asking the teammate to do it again. */
  redoOfRunId: z.string().nullable(),
  createdAt: isoDate,
});
export type MessageView = z.infer<typeof messageViewSchema>;

export const runTriggerSchema = z.enum([
  "user",
  "schedule",
  "watch",
  "webhook",
  "hand_back",
  "approval",
  "handoff",
  "question",
  "answer",
  "task",
  "takeover_ended",
  "swarm",
  "swarm_results",
  "email",
]);

/**
 * A run's timeline, folded from its run events by `applyRunEvent` in `@open-bot/shared`. The
 * worker writes these items and the shared types describe them, so they're passed through as is.
 */
const timelineSchema = z.custom<RunTimelineState>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    Array.isArray((value as { items?: unknown }).items),
);

export const runViewSchema = z.object({
  id: z.string(),
  botId: z.string(),
  trigger: runTriggerSchema,
  messageId: z.string().nullable(),
  parentRunId: z.string().nullable(),
  /** For handoffs, questions and answers: the teammate this run came from. */
  fromBotId: z.string().nullable(),
  /** How the run reached the model; null before it started. */
  authMode: z.enum(["plan", "api_key"]).nullable(),
  scheduleTitle: z.string().nullable(),
  /** The watch or webhook that started the run. */
  triggerTitle: z.string().nullable(),
  /** For runs an automation started: what the teammate was given. */
  automationPrompt: z.string().nullable(),
  /** Your thumbs up or down on the reply. */
  rating: z.enum(["up", "down"]).nullable(),
  /** Tokens and cost of the run, once the model reported them. */
  usage: z.object({ tokens: z.number(), costMicros: z.number() }).nullable(),
  createdAt: isoDate,
  startedAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
  timeline: timelineSchema,
});
export type RunView = z.infer<typeof runViewSchema>;

export const chatEntrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), at: isoDate, message: messageViewSchema }),
  z.object({ type: z.literal("run"), at: isoDate, run: runViewSchema }),
]);
export type ChatEntry = z.infer<typeof chatEntrySchema>;

export const swarmTaskStateSchema = z.enum(["queued", "running", "completed", "failed", "stopped"]);

export const chatDataSchema = z.object({
  chat: chatSummarySchema,
  members: z.array(botSummarySchema),
  entries: z.array(chatEntrySchema),
  /** The id of the last run event included. Stream from here. */
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  /** For a swarm helper's chat: the screen it works on and the swarm it's part of. */
  helper: z
    .object({
      screenId: z.string(),
      state: swarmTaskStateSchema,
      swarmTitle: z.string(),
      swarmChatId: z.string(),
      swarmRunId: z.string(),
    })
    .nullable(),
});
export type ChatData = z.infer<typeof chatDataSchema>;

export const approvalStatusSchema = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalKindSchema = z.enum(["command", "file_change", "action", "purchase", "email"]);

export const approvalViewSchema = z.object({
  id: z.string(),
  runId: z.string(),
  botId: z.string(),
  chatId: z.string(),
  kind: approvalKindSchema,
  /** What "always allow" matches: the raw command, or a kind of action like "Create teammates". */
  subject: z.string().nullable(),
  /** Asked about every time, like giving a teammate access; no "always allow". */
  askEveryTime: z.boolean(),
  title: z.string(),
  detail: z.string(),
  status: approvalStatusSchema,
  createdAt: isoDate,
  decidedAt: isoDate.nullable(),
});
export type ApprovalView = z.infer<typeof approvalViewSchema>;
