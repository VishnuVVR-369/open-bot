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
  /** A teammate replied since you last looked at the chat, here or on another device. */
  unread: z.boolean(),
  /** The latest thing said in the chat, on one line: by a teammate, or by you (`botId` null). */
  preview: z.object({ text: z.string(), botId: z.string().nullable() }).nullable(),
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
  /**
   * This page's chat-wide event checkpoint. Runs retained from other pages may still need replay
   * from their earlier checkpoints.
   */
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

export const approvalRuleKindSchema = z.enum(["command", "file_change", "action"]);

/** Something a teammate may do without asking, from "Always allow" on an approval. */
export const approvalRuleSchema = z.object({
  id: z.string(),
  botId: z.string(),
  kind: approvalRuleKindSchema,
  /** The start of a command, or an action in plain words. Empty for file changes. */
  pattern: z.string(),
  createdAt: isoDate,
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

export const notificationViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  botId: z.string().nullable(),
  chatId: z.string().nullable(),
  runId: z.string().nullable(),
  readAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

/** A teammate's turn, as Home lists it. */
export const activityItemSchema = z.object({
  runId: z.string(),
  chatId: z.string(),
  chatKind: chatKindSchema,
  chatTitle: z.string(),
  botId: z.string(),
  trigger: runTriggerSchema,
  status: runStatusSchema,
  /** The reply, or why it failed, in Markdown. */
  preview: z.string().nullable(),
  createdAt: isoDate,
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

/** Something a teammate finished while you were away. */
export const briefingItemSchema = activityItemSchema.extend({
  completedAt: isoDate,
  /** The schedule, watch or webhook that started it. */
  automationTitle: z.string().nullable(),
});
export type BriefingItem = z.infer<typeof briefingItemSchema>;

export const takeoverRequestSchema = z.object({
  id: z.string(),
  /** The screen to take over: the requesting teammate's. */
  screenId: z.string(),
  botId: z.string().nullable(),
  botName: z.string(),
  reason: z.string(),
  chatId: z.string().nullable(),
  createdAt: isoDate,
});
export type TakeoverRequest = z.infer<typeof takeoverRequestSchema>;

/** Home: what needs you, what happened while you were away, and recent work. */
export const homeSchema = z.object({
  user: z.object({ name: z.string() }),
  pendingApprovals: z.number().int().nonnegative(),
  takeoverRequests: z.array(takeoverRequestSchema),
  /** Teammates that suggested new instructions, waiting for you on the web. */
  proposals: z.array(z.object({ id: z.string(), botId: z.string() })),
  unreadNotifications: z.number().int().nonnegative(),
  /** Finished since `awaySince`, newest first; empty without it. */
  briefing: z.array(briefingItemSchema),
  activity: z.array(activityItemSchema),
});
export type Home = z.infer<typeof homeSchema>;

/** A message or a teammate's reply that matched a search. */
export const searchResultSchema = z.object({
  id: z.string(),
  /** "you" for your messages, "bot" for a teammate's reply. */
  from: z.enum(["you", "bot"]),
  chatId: z.string(),
  runId: z.string().nullable(),
  botId: z.string().nullable(),
  /** The part of the text around the match. */
  excerpt: z.string(),
  createdAt: isoDate,
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const uploadStatusSchema = z.enum(["writing", "complete", "failed"]);

/** An attachment being uploaded with `PUT /api/uploads/<id>`, or one that finished. */
export const uploadViewSchema = z.object({
  id: z.string(),
  status: uploadStatusSchema,
  /** Once complete: what to attach to a message. */
  attachment: attachmentSchema.nullable(),
});
export type UploadView = z.infer<typeof uploadViewSchema>;
