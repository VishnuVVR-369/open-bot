import type { InferContractRouterInputs, InferContractRouterOutputs } from "@orpc/contract";
import { MAX_LESSON_CHARS, memoryItemSchema, memoryRevisionSchema } from "@open-bot/domain";
import { z } from "zod";
import { automationRunViewSchema, scheduleViewSchema, triggerViewSchema } from "./automations";
import { base, id, ok } from "./base";
import {
  egressDeviceViewSchema,
  egressModeSchema,
  egressStatusSchema,
  phoneEgressModeSchema,
} from "./egress";
import { appStateSchema, homeSchema } from "./home";
import {
  accountsSetupViewSchema,
  connectionViewSchema,
  emailStatusViewSchema,
} from "./integrations";
import { memoryRunRefSchema } from "./memory";
import {
  screenFrameSchema,
  screenViewSchema,
  screenOperationSchema,
  typeOnScreenSchema,
} from "./screens";
import { modelAccessViewSchema, profileViewSchema, usageViewSchema } from "./settings";
import { skillViewSchema } from "./skills";
import { taskViewSchema } from "./tasks";
import { lessonViewSchema, spendingViewSchema } from "./teammates";
import { vaultItemViewSchema } from "./vault";
import {
  approvalRuleSchema,
  approvalStatusSchema,
  approvalViewSchema,
  attachmentSchema,
  botSummarySchema,
  chatDataSchema,
  chatSummarySchema,
  messageViewSchema,
  notificationViewSchema,
  pageDetailSchema,
  pageLinkSchema,
  pageSummarySchema,
  searchResultSchema,
  uploadViewSchema,
} from "./views";
import {
  codexRateLimitsSchema,
  fileListingSchema,
  pushStatusSchema,
  telegramStatusSchema,
} from "./worker/views";

export { API_ERRORS } from "./base";

/**
 * The open-bot API, shared by the web app (which implements it at `/api/rpc`, and reads through
 * it in the browser) and the phone (which calls it). Only the contract lives here, never server
 * code, so the phone can import it.
 *
 * Every procedure needs the owner's session. Retryable operations take a client-generated id; a
 * retry with the same id returns the first result, and the same id with a different request is a
 * `CONFLICT`.
 */

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

export const decideApprovalInputSchema = z.object({
  approvalId: id,
  decision: z.enum(["approved", "denied"]),
  /** Approve, and stop asking about what this pattern matches. */
  alwaysAllow: z.object({ pattern: z.string().max(300) }).nullable(),
});

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

export const contract = {
  app: {
    /**
     * What the web app's shell shows on every screen: your team, chats, the computer, skills and
     * what needs you.
     */
    state: base.output(appStateSchema),
  },
  screens: {
    list: base.output(z.array(screenViewSchema)),
    /** Each screen's last captured frame, by screen id, to show while the computer sleeps. */
    frames: base.output(z.record(z.string(), screenFrameSchema)),
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
    /** What a teammate learned from your feedback, newest first. */
    lessons: base.input(z.object({ botId: id })).output(z.array(lessonViewSchema)),
    /** A teammate's monthly budget, what it spent, and its latest purchases. */
    spending: base.input(z.object({ botId: id })).output(spendingViewSchema),
  },
  schedules: {
    list: base.output(z.array(scheduleViewSchema)),
    /** A schedule's latest runs, newest first. */
    runs: base.input(z.object({ scheduleId: id })).output(z.array(automationRunViewSchema)),
  },
  triggers: {
    /** Page watches, webhooks, and Gmail and Calendar triggers. */
    list: base.output(z.array(triggerViewSchema)),
    /** A trigger's latest runs, newest first. */
    runs: base.input(z.object({ triggerId: id })).output(z.array(automationRunViewSchema)),
  },
  skills: {
    list: base.output(z.array(skillViewSchema)),
  },
  tasks: {
    /** The team's board, in board order. */
    list: base.output(z.array(taskViewSchema)),
  },
  vault: {
    /** Logins and cards, without their secrets. */
    list: base.output(z.array(vaultItemViewSchema)),
  },
  profile: {
    /** What every teammate knows about you. */
    get: base.output(profileViewSchema),
  },
  memory: {
    /** Memories you can see and edit, matching `query`: one teammate's, or everyone's with null. */
    list: base
      .input(z.object({ botId: id.nullable(), query: z.string().max(200) }))
      .output(z.array(memoryItemSchema)),
    /** Every revision of a memory, newest first. */
    history: base.input(z.object({ memoryId: id })).output(z.array(memoryRevisionSchema)),
    /** The memories a reply was given. */
    forRun: base.input(z.object({ runId: id })).output(z.array(memoryRunRefSchema)),
  },
  files: {
    /**
     * A folder on the computer, inside `/home/bot`. Wakes the computer if it sleeps; fails with
     * `SERVICE_UNAVAILABLE` while it can't be reached.
     */
    list: base.input(z.object({ path: z.string().max(4096) })).output(fileListingSchema),
  },
  connections: {
    /** MCP servers and accounts teammates use, without their secrets. */
    list: base.output(z.array(connectionViewSchema)),
  },
  accounts: {
    /** What connecting an account needs, per provider, and the accounts signed in. */
    setup: base.output(accountsSetupViewSchema),
  },
  email: {
    status: base.output(emailStatusViewSchema),
  },
  telegram: {
    /** Fails with `SERVICE_UNAVAILABLE` while the worker can't be reached. */
    status: base.output(telegramStatusSchema),
  },
  settings: {
    /** The API key fallback and what it spent this month. */
    modelAccess: base.output(modelAccessViewSchema),
    /** Tokens each teammate used this month. */
    usage: base.output(z.array(usageViewSchema)),
    /** ChatGPT's usage limits as last read. */
    rateLimits: base.output(codexRateLimitsSchema.shape.rateLimits),
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
          botIds: z
            .array(id)
            .min(2, "Pick at least two teammates.")
            .max(MAX_GROUP_TEAMMATES, `A group can have up to ${MAX_GROUP_TEAMMATES} teammates.`),
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
  pages: {
    /** Every page, pinned first, then the most recently updated. */
    list: base.output(z.array(pageSummarySchema)),
    /** Pages whose title, summary or text has the words, newest first. */
    search: base.input(z.object({ query: z.string().max(200) })).output(z.array(pageSummarySchema)),
    get: base.input(z.object({ pageId: id })).output(pageDetailSchema),
    /**
     * An address that shows a version for the next few minutes, on the pages origin (never the
     * app's). `ask` offers "Ask about this" on selected text; see `parsePageAskMessage`.
     */
    open: base
      .input(
        z.object({
          versionId: id,
          theme: z.enum(["light", "dark"]).optional(),
          ask: z.boolean().optional(),
        }),
      )
      .output(pageLinkSchema),
    pin: base.input(z.object({ pageId: id, pinned: z.boolean() })).output(ok),
    /** Delete a page and every version of it. */
    remove: base.input(z.object({ pageId: id })).output(ok),
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
  egress: {
    /** Where the computer's browser traffic goes now, and each device's state. */
    status: base.output(egressStatusSchema),
    setMode: base.input(z.object({ mode: egressModeSchema })).output(ok),
    setPhoneMode: base.input(z.object({ mode: phoneEgressModeSchema })).output(ok),
    /** Phones paired to carry the traffic. */
    devices: base.output(z.array(egressDeviceViewSchema)),
    /**
     * Pair this phone, or pair it again. Returns its new secret, once; the phone's native code
     * keeps it. Pairing again rotates the secret and makes the old one useless.
     */
    registerDevice: base
      .input(
        z.object({
          deviceId: id,
          name: z.string().trim().min(1).max(80),
          /** The phone's FCM token, for waking it; null without push notifications. */
          pushToken: z.string().min(1).max(4096).nullable(),
        }),
      )
      .output(z.object({ secret: z.string(), generation: z.number().int().positive() })),
    /**
     * Unpair a phone. With `generation`, only that pairing is revoked, so a revoke delayed from an
     * offline sign-out can't undo a later pairing.
     */
    revokeDevice: base
      .input(z.object({ deviceId: id, generation: z.number().int().positive().optional() }))
      .output(ok),
  },
  push: {
    /** The key browsers subscribe with, and the browsers subscribed. */
    status: base.output(pushStatusSchema),
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
