import { MAX_LESSON_CHARS, runRatingSchema } from "@open-bot/domain";
import { z } from "zod";
import { base, id, ok } from "../base";
import {
  attachmentSchema,
  chatDataSchema,
  chatSummarySchema,
  messageViewSchema,
  searchResultSchema,
} from "../views";

/** The most teammates one group chat can have. */
export const MAX_GROUP_TEAMMATES = 20;

export const sendMessageInputSchema = z.object({
  /** A new UUID per message; reuse it to retry the same send. */
  clientId: id,
  chatId: id,
  text: z.string().max(200_000),
  attachments: z.array(attachmentSchema).max(20),
  /** Teammates the message addresses with @mentions, in a group chat. */
  mentions: z.array(id).max(20),
});

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const chatTitleSchema = z.string().trim().min(1, "Name the chat.").max(60);

/** The teammates in a new group chat. */
export const groupTeammatesSchema = z
  .array(id)
  .min(2, "Pick at least two teammates.")
  .max(MAX_GROUP_TEAMMATES, `A group can have up to ${MAX_GROUP_TEAMMATES} teammates.`);

export const feedbackInputSchema = z.object({
  runId: id,
  text: z
    .string()
    .trim()
    .min(1, "Say what to do differently.")
    .max(MAX_LESSON_CHARS, `Keep it under ${MAX_LESSON_CHARS} characters.`),
  /** Keep it as a lesson the teammate reads before every task. */
  remember: z.boolean(),
  /**
   * Ask the teammate to try again now, with this as a new message. Its id makes a retry of the
   * same feedback safe; without `redo` it's ignored.
   */
  redo: z.object({ clientId: id }).nullable(),
});

export const chatsContract = {
  /** Your chats, most recent activity first. */
  list: base.output(z.array(chatSummarySchema)),
  /** A chat's latest messages and runs, or the page before `before` (an ISO date). */
  get: base
    .input(z.object({ chatId: id, before: z.string().datetime({ offset: true }).optional() }))
    .output(chatDataSchema),
  /** Start a new direct chat with a teammate. */
  newDirect: base.input(z.object({ botId: id })).output(z.object({ chatId: z.string() })),
  /** Start a group chat with two or more teammates. */
  createGroup: base
    .input(
      z.object({
        title: z.string().trim().min(1, "Name the group.").max(60),
        botIds: groupTeammatesSchema,
      }),
    )
    .output(z.object({ chatId: z.string() })),
  rename: base.input(z.object({ chatId: id, title: chatTitleSchema })).output(ok),
  /** Hide a chat from your lists. Its history stays. */
  archive: base.input(z.object({ chatId: id })).output(ok),
  /** Make a chat with one teammate its main chat, where work that isn't started from a chat arrives. */
  makeMain: base.input(z.object({ chatId: id })).output(ok),
  /** You've seen what's in the chat, so it isn't unread on any device. */
  markRead: base.input(z.object({ chatId: id })).output(ok),
  /**
   * Send a message. It's saved before anything else, and the teammates it's for get it exactly
   * once. Sending again with the same `clientId` is safe.
   */
  send: base.input(sendMessageInputSchema).output(messageViewSchema),
};

export const runsContract = {
  /**
   * Run a failed or stopped request again. Asking again after it already ran again returns
   * that run instead of starting another.
   */
  retry: base.input(z.object({ runId: id })).output(z.object({ runId: z.string() })),
  /** Stop a teammate's running (or queued) turn. */
  cancel: base.input(z.object({ runId: id })).output(ok),
  /** Thumbs up or down on a reply, or neither. */
  rate: base.input(z.object({ runId: id, rating: runRatingSchema.nullable() })).output(ok),
  /** A thumbs down with what to change; see `feedbackInputSchema`. */
  feedback: base.input(feedbackInputSchema).output(ok),
};

export const swarmsContract = {
  /** Stop every helper in a swarm. The teammate doesn't get their results. */
  stop: base.input(z.object({ swarmId: id })).output(ok),
};

export const searchContract = {
  /** Your messages and teammates' replies that contain the text, newest first. */
  messages: base
    .input(z.object({ query: z.string().max(200) }))
    .output(z.array(searchResultSchema)),
};
