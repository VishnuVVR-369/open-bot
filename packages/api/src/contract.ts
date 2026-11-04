import {
  oc,
  type InferContractRouterInputs,
  type InferContractRouterOutputs,
} from "@orpc/contract";
import { MAX_LESSON_CHARS } from "@open-bot/shared";
import { z } from "zod";
import { screenViewSchema, screenOperationSchema, typeOnScreenSchema } from "./screens";
import {
  approvalRuleSchema,
  approvalStatusSchema,
  approvalViewSchema,
  attachmentSchema,
  botSummarySchema,
  chatDataSchema,
  chatSummarySchema,
  homeSchema,
  messageViewSchema,
  notificationViewSchema,
  searchResultSchema,
  uploadViewSchema,
} from "./views";

/**
 * The open-bot API, shared by the web app (which implements it at `/api/rpc`) and the phone (which
 * calls it). Only the contract lives here, never server code, so the phone can import it.
 *
 * Every procedure needs the owner's session. Retryable operations take a client-generated id; a
 * retry with the same id returns the first result, and the same id with a different request is a
 * `CONFLICT`.
 */

const id = z.string().uuid();

/** Errors a caller is expected to handle, beyond the common ones (`UNAUTHORIZED`, `BAD_REQUEST`). */
export const API_ERRORS = {
  NOT_FOUND: { status: 404, message: "That's gone." },
  /** A retry reused a client id for a different request. */
  CONFLICT: { status: 409, message: "That id was already used for something else." },
  /** Decided differently somewhere else, or expired. `data.status` says how it ended. */
  ALREADY_DECIDED: {
    status: 409,
    message: "This was already decided.",
    data: z.object({ status: approvalStatusSchema }),
  },
} as const;

const base = oc.errors(API_ERRORS);

export const sendMessageInputSchema = z.object({
  /** A new UUID per message; reuse it to retry the same send. */
  clientId: id,
  chatId: id,
  text: z.string().max(200_000),
  attachments: z.array(attachmentSchema).max(20),
  /** Teammates the message addresses with @mentions, in a group chat. */
  mentions: z.array(id).max(20),
});

export const decideApprovalInputSchema = z.object({
  approvalId: id,
  decision: z.enum(["approved", "denied"]),
  /** Approve, and stop asking about what this pattern matches. */
  alwaysAllow: z.object({ pattern: z.string().max(300) }).nullable(),
});

const ok = z.object({ ok: z.literal(true) });

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

/**
 * Attachments are uploaded as raw bytes with `PUT /api/uploads/<uploadId>`, with the headers
 * below, then sent with a message. Retrying an upload with the same id never stores it twice.
 */
export const UPLOAD_HEADERS = {
  /** The file's name, URI-encoded. */
  name: "x-upload-name",
  mime: "x-upload-mime",
  /** The size in bytes. */
  size: "x-upload-size",
  /** The SHA-256 of the file, in hex. */
  sha256: "x-upload-sha256",
} as const;

export const contract = {
  screens: {
    list: base.output(z.array(screenViewSchema)),
    takeOver: base.input(z.object({ screenId: id })).output(ok),
    handBack: base
      .input(
        z.object({
          screenId: id,
          note: z.string().max(2000).nullable(),
          clearCode: z.boolean().optional(),
        }),
      )
      .output(ok),
    wake: base.input(z.object({ screenId: id })).output(ok),
    activity: base.input(z.object({ screenId: id })).output(ok),
  },
  takeovers: {
    dismiss: base.input(z.object({ takeoverId: id })).output(ok),
    codeContext: base
      .input(z.object({ takeoverId: id }))
      .output(z.object({ screenId: id, site: z.string().nullable() })),
  },
  screenOperations: {
    type: base.input(typeOnScreenSchema).output(screenOperationSchema),
    get: base.input(z.object({ operationId: id })).output(screenOperationSchema.nullable()),
    cancel: base.input(z.object({ operationId: id })).output(screenOperationSchema),
  },
  home: {
    /**
     * What needs you, recent work, and (with `awaySince`, when you were last here) what
     * teammates finished while you were away.
     */
    get: base
      .input(z.object({ awaySince: z.string().datetime({ offset: true }).nullable() }))
      .output(homeSchema),
  },
  teammates: {
    /** Your teammates (not archived), oldest first, with what each is doing now. */
    list: base.output(z.array(botSummarySchema)),
  },
  chats: {
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
          botIds: z.array(id).min(2, "Pick at least two teammates.").max(20),
        }),
      )
      .output(z.object({ chatId: z.string() })),
    rename: base
      .input(z.object({ chatId: id, title: z.string().trim().min(1, "Name the chat.").max(60) }))
      .output(ok),
    /** Hide a chat from your lists. Its history stays. */
    archive: base.input(z.object({ chatId: id })).output(ok),
    /** You've seen what's in the chat, so it isn't unread on any device. */
    markRead: base.input(z.object({ chatId: id })).output(ok),
    /**
     * Send a message. It's saved before anything else, and the teammates it's for get it exactly
     * once, even if the worker is down right now (it's delivered when the worker is back).
     */
    send: base.input(sendMessageInputSchema).output(messageViewSchema),
  },
  runs: {
    /**
     * Run a failed or stopped request again. Asking again after it already ran again returns
     * that run instead of starting another.
     */
    retry: base.input(z.object({ runId: id })).output(z.object({ runId: z.string() })),
    /** Stop a teammate's running (or queued) turn. */
    cancel: base.input(z.object({ runId: id })).output(ok),
    /** Thumbs up or down on a reply, or neither. */
    rate: base.input(z.object({ runId: id, rating: z.enum(["up", "down"]).nullable() })).output(ok),
    /** A thumbs down with what to change; see `feedbackInputSchema`. */
    feedback: base.input(feedbackInputSchema).output(ok),
  },
  swarms: {
    /** Stop every helper in a swarm. The teammate doesn't get their results. */
    stop: base.input(z.object({ swarmId: id })).output(ok),
  },
  uploads: {
    /** How an upload went, to check one whose response was lost before trying it again. */
    status: base.input(z.object({ uploadId: id })).output(uploadViewSchema),
  },
  notifications: {
    /** The latest notifications, newest first. */
    list: base.output(z.array(notificationViewSchema)),
    /**
     * Mark these as read; or, with `through`, that one and every older one (the list shows only
     * the newest, so it's how "I've seen the list" reaches the ones below it, without touching
     * any that came in since); or all of them without either.
     */
    markRead: base
      .input(z.object({ ids: z.array(id).max(200).optional(), through: id.optional() }))
      .output(ok),
  },
  search: {
    /** Your messages and teammates' replies that contain the text, newest first. */
    messages: base
      .input(z.object({ query: z.string().max(200) }))
      .output(z.array(searchResultSchema)),
  },
  approvals: {
    /** Pending approvals first, then recent decisions. */
    list: base.output(z.array(approvalViewSchema)),
    get: base.input(z.object({ approvalId: id })).output(approvalViewSchema),
    /**
     * Approve or deny. Deciding again the same way succeeds; if it was decided differently
     * elsewhere, or expired, it fails with `ALREADY_DECIDED` and how it ended.
     */
    decide: base
      .input(decideApprovalInputSchema)
      .output(z.object({ status: approvalStatusSchema })),
    /** What each teammate may do without asking. */
    rules: base.output(z.array(approvalRuleSchema)),
    /** Make a teammate ask about this again. */
    removeRule: base.input(z.object({ ruleId: id })).output(ok),
  },
  push: {
    /** Send notifications to this phone, by its Firebase Cloud Messaging token. */
    registerDevice: base
      .input(
        z.object({
          token: z.string().min(1).max(4096),
          platform: z.literal("android"),
          /** The device, in words, like "Pixel 9". */
          device: z.string().max(200),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    unregisterDevice: base
      .input(z.object({ token: z.string().min(1).max(4096) }))
      .output(z.object({ ok: z.literal(true) })),
    /** Send a test notification to every device. */
    test: base.output(z.object({ sent: z.number().int().nonnegative() })),
  },
};

export type Contract = typeof contract;

/** What each procedure takes, as callers write it. */
export type ApiInputs = InferContractRouterInputs<Contract>;
/** What each procedure returns. */
export type ApiOutputs = InferContractRouterOutputs<Contract>;
