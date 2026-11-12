import type { InferContractRouterInputs, InferContractRouterOutputs } from "@orpc/contract";
import {
  approvalDecisionSchema,
  approvalStatusSchema,
  botProfileSchema as profileSchema,
  chatgptAuthSourceSchema,
  createdTeammateSchema,
  egressModeSchema,
  MAX_LESSON_CHARS,
  memoryEditSchema,
  memoryInputSchema,
  memoryItemSchema,
  memoryReferenceSchema,
  memoryRevisionSchema,
  memorySaveOutcomeSchema,
  pageThemeSchema,
  phoneModeSchema,
  runRatingSchema,
  skillInputSchema,
  updatedTeammateSchema,
} from "@open-bot/domain";
import { z } from "zod";
import {
  automationRunViewSchema,
  scheduleInputSchema,
  scheduleViewSchema,
  triggerInputSchema,
  triggerViewSchema,
} from "./automations";
import { base, id, ok } from "./base";
import { egressDeviceViewSchema, egressStatusSchema } from "./egress";
import { appStateSchema, homeSchema } from "./home";
import {
  accountConnectInputSchema,
  accountConnectionChangesSchema,
  accountsSetupViewSchema,
  connectionInputSchema,
  connectionViewSchema,
  emailSettingsInputSchema,
  emailStatusViewSchema,
  oauthClientInputSchema,
} from "./integrations";
import { memoryRunRefSchema } from "./memory";
import {
  screenFrameSchema,
  screenViewSchema,
  screenOperationSchema,
  typeOnScreenSchema,
} from "./screens";
import {
  apiKeyInputSchema,
  modelAccessViewSchema,
  monthlyCapInputSchema,
  profileViewSchema,
  usageViewSchema,
} from "./settings";
import { skillViewSchema } from "./skills";
import { taskChangesSchema, taskInputSchema, taskViewSchema } from "./tasks";
import { budgetInputSchema, lessonViewSchema, spendingViewSchema } from "./teammates";
import { vaultItemInputSchema, vaultItemViewSchema } from "./vault";
import {
  approvalRuleSchema,
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
  codexStatusSchema,
  connectionTestSchema,
  fileListingSchema,
  pushStatusSchema,
  telegramStatusSchema,
  triggerCheckSchema,
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

/** The biggest teammate file that can be imported, in characters. */
export const MAX_TEAMMATE_FILE = 2_000_000;

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

export const decideApprovalInputSchema = z.object({
  approvalId: id,
  decision: approvalDecisionSchema,
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
    /**
     * A new teammate, with its template's skills and the starter automations you kept, made by the
     * same service as when a teammate creates one.
     */
    create: base
      .input(
        z.object({
          profile: profileSchema,
          templateId: z.string().min(1).nullable(),
          starterIds: z.array(z.string().max(80)).max(20),
        }),
      )
      .output(createdTeammateSchema),
    /**
     * Save the profile. `revision` is the teammate as you loaded it: a change made since, by you
     * elsewhere or by a teammate, fails with `STATE_CONFLICT` instead of being overwritten.
     */
    update: base
      .input(
        z.object({ teammateId: id, profile: profileSchema, revision: z.string().min(1).max(128) }),
      )
      .output(updatedTeammateSchema),
    /**
     * A new teammate set up like another: the same job, instructions and carefulness, their own
     * skills and approval rules, and their routines and page watches, paused. Webhooks and chats
     * stay with the original. Memory and lessons come along with `copyMemory`.
     */
    duplicate: base
      .input(z.object({ teammateId: id, name: profileSchema.shape.name, copyMemory: z.boolean() }))
      .output(z.object({ teammateId: z.string(), chatId: z.string(), memoryCopied: z.boolean() })),
    /** A new teammate from an exported file; its routines and page watches start paused. */
    import: base
      .input(
        z.object({
          file: z.string().max(MAX_TEAMMATE_FILE, "Teammate files are smaller than that."),
        }),
      )
      .output(
        z.object({
          teammateId: z.string(),
          chatId: z.string(),
          name: z.string(),
          /** How many routines and watches came in paused. */
          paused: z.number().int().nonnegative(),
        }),
      ),
    /** Make this teammate the lead, who answers group chats when nobody is mentioned. */
    setLead: base.input(z.object({ teammateId: id })).output(ok),
    /** Archive a teammate: its chats are archived, its automations paused, its work stopped. */
    archive: base.input(z.object({ teammateId: id })).output(ok),
    /** What a teammate may spend from the vault's cards each month; see `budgetInputSchema`. */
    setBudget: base.input(budgetInputSchema).output(ok),
  },
  proposals: {
    /**
     * Take the instructions a teammate suggested for itself; they apply from its next message.
     * Deciding again the same way succeeds; one decided the other way fails with
     * `STATE_CONFLICT`.
     */
    accept: base.input(z.object({ proposalId: id })).output(ok),
    dismiss: base.input(z.object({ proposalId: id })).output(ok),
  },
  schedules: {
    list: base.output(z.array(scheduleViewSchema)),
    /** A schedule's latest runs, newest first. */
    runs: base.input(z.object({ scheduleId: id })).output(z.array(automationRunViewSchema)),
    create: base.input(scheduleInputSchema).output(z.object({ id: z.string() })),
    update: base
      .input(scheduleInputSchema.extend({ scheduleId: id }))
      .output(z.object({ id: z.string() })),
    setEnabled: base.input(z.object({ scheduleId: id, enabled: z.boolean() })).output(ok),
    remove: base.input(z.object({ scheduleId: id })).output(ok),
    /** Run it now, without changing when it runs next. */
    runNow: base.input(z.object({ scheduleId: id })).output(ok),
    /**
     * A teammate's daily check-in, on or off: every morning it looks over its area and tells you
     * only what needs you. Turning it on resumes a paused one rather than adding another.
     */
    setCheckIn: base.input(z.object({ teammateId: id, on: z.boolean() })).output(ok),
  },
  triggers: {
    /** Page watches, webhooks, and Gmail and Calendar triggers. */
    list: base.output(z.array(triggerViewSchema)),
    /** A trigger's latest runs, newest first. */
    runs: base.input(z.object({ triggerId: id })).output(z.array(automationRunViewSchema)),
    create: base
      .input(triggerInputSchema)
      .output(z.object({ id: z.string(), hookPath: z.string().nullable() })),
    update: base
      .input(triggerInputSchema.extend({ triggerId: id }))
      .output(z.object({ id: z.string() })),
    setEnabled: base.input(z.object({ triggerId: id, enabled: z.boolean() })).output(ok),
    remove: base.input(z.object({ triggerId: id })).output(ok),
    /** Look at the watched page, mail or calendar now. */
    check: base.input(z.object({ triggerId: id })).output(triggerCheckSchema),
    /** Give a webhook a new URL. The old one stops working. */
    rotateToken: base.input(z.object({ triggerId: id })).output(z.object({ token: z.string() })),
    /** Call a webhook with a sample request, as a service would. */
    test: base.input(z.object({ triggerId: id })).output(z.object({ runId: z.string() })),
  },
  skills: {
    list: base.output(z.array(skillViewSchema)),
    /** Create a skill, or with `id`, change one. */
    save: base
      .input(skillInputSchema.extend({ id: id.nullable().optional() }))
      .output(z.object({ id: z.string() })),
    remove: base.input(z.object({ skillId: id })).output(ok),
  },
  tasks: {
    /** The team's board, in board order. */
    list: base.output(z.array(taskViewSchema)),
    create: base.input(taskInputSchema).output(z.object({ id: z.string() })),
    update: base.input(taskChangesSchema.extend({ taskId: id })).output(ok),
    remove: base.input(z.object({ taskId: id })).output(ok),
    /** Hand the task to its teammate in a new chat. */
    start: base.input(z.object({ taskId: id })).output(z.object({ chatId: z.string().nullable() })),
  },
  vault: {
    /** Logins and cards, without their secrets. */
    list: base.output(z.array(vaultItemViewSchema)),
    /** Save a login or card. Its secret is encrypted on the server and never sent back. */
    save: base.input(vaultItemInputSchema).output(z.object({ id: z.string() })),
    remove: base.input(z.object({ itemId: id })).output(ok),
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
    /**
     * Save a memory you wrote. Saying what's already saved confirms it instead of adding another;
     * `saveOutcome` says which happened.
     */
    create: base
      .input(memoryInputSchema)
      .output(memoryItemSchema.extend({ saveOutcome: memorySaveOutcomeSchema })),
    /**
     * Change a memory. `expectedRevision` is the one you saw: a change made since fails with
     * `STATE_CONFLICT` instead of being overwritten. The same holds for `forget`, `confirm` and
     * `restore`.
     */
    update: base.input(memoryEditSchema).output(memoryItemSchema),
    forget: base.input(memoryReferenceSchema).output(ok),
    /** Make a teammate's suggested memory a real one. */
    confirm: base.input(memoryReferenceSchema).output(memoryItemSchema),
    /** Make an earlier revision the current one, as a new revision. */
    restore: base
      .input(memoryReferenceSchema.extend({ revision: z.number().int().positive() }))
      .output(memoryItemSchema),
  },
  files: {
    /**
     * A folder on the computer, inside `/home/bot`. Wakes the computer if it sleeps; fails with
     * `SERVICE_UNAVAILABLE` while it can't be reached.
     */
    list: base.input(z.object({ path: z.string().max(4096) })).output(fileListingSchema),
    /**
     * Delete a file or folder. Refused for folders the system needs, like an active teammate's
     * workspace. Adding a file is `PUT /api/files/upload`, which takes its bytes.
     */
    remove: base.input(z.object({ path: z.string().min(1).max(4096) })).output(ok),
  },
  connections: {
    /** MCP servers and accounts teammates use, without their secrets. */
    list: base.output(z.array(connectionViewSchema)),
    /** Save an MCP server. Its headers and variables are encrypted and never sent back. */
    save: base.input(connectionInputSchema).output(z.object({ id: z.string() })),
    /** Turn a connection on or off. Turning an account off cancels what waits on it. */
    setEnabled: base.input(z.object({ connectionId: id, enabled: z.boolean() })).output(ok),
    /**
     * Remove a connection. The last connection using an account also revokes its access at the
     * provider; `warning` says when that couldn't be done.
     */
    remove: base
      .input(z.object({ connectionId: id }))
      .output(z.object({ warning: z.string().nullable() })),
    /** Connect to the service from the computer, and list what it offers. Wakes the computer. */
    test: base.input(z.object({ connectionId: id })).output(connectionTestSchema),
  },
  accounts: {
    /** What connecting an account needs, per provider, and the accounts signed in. */
    setup: base.output(accountsSetupViewSchema),
    /** Save the OAuth client you made in a provider's console, for new sign-ins to use. */
    saveClient: base.input(oauthClientInputSchema).output(ok),
    /**
     * Start connecting an account: returns the provider's sign-in page to go to, in this browser
     * (the sign-in is tied to this session).
     */
    connect: base.input(accountConnectInputSchema).output(z.object({ url: z.string() })),
    /**
     * Change what an account connection allows and who uses it. When it allows more than the
     * account granted, nothing changes and `needsConsent` says to sign in again for it.
     */
    update: base
      .input(accountConnectionChangesSchema)
      .output(z.object({ needsConsent: z.boolean() })),
  },
  email: {
    status: base.output(emailStatusViewSchema),
    /** Your teammates' email domain and Postmark's server token, which sends what they write. */
    save: base.input(emailSettingsInputSchema).output(ok),
    /** Forget Postmark's token: teammates receive email but can't send it. */
    removeToken: base.output(ok),
  },
  telegram: {
    /** Fails with `SERVICE_UNAVAILABLE` while the worker can't be reached. */
    status: base.output(telegramStatusSchema),
    /** Connect Telegram with the token BotFather gave you. */
    connect: base.input(z.object({ token: z.string().max(200) })).output(telegramStatusSchema),
    /** A code to send from the Telegram account to link, and the chat link to send it in. */
    linkCode: base.output(z.object({ code: z.string(), url: z.string(), expiresAt: z.string() })),
    sendTest: base.output(ok),
    /** Forget the linked Telegram account; the token stays connected. */
    unlink: base.output(ok),
    disconnect: base.output(ok),
  },
  chatgpt: {
    /** Sign in with a device code, or with the login of the Mac running the stack. */
    setAuthSource: base
      .input(z.object({ source: chatgptAuthSourceSchema }))
      .output(codexStatusSchema),
    /** Start a device-code sign-in: open the URL and enter the code. */
    startLogin: base.output(z.object({ verificationUrl: z.string(), userCode: z.string() })),
    signOut: base.output(ok),
  },
  settings: {
    /** The API key fallback and what it spent this month. */
    modelAccess: base.output(modelAccessViewSchema),
    /** Tokens each teammate used this month. */
    usage: base.output(z.array(usageViewSchema)),
    /** ChatGPT's usage limits as last read. */
    rateLimits: base.output(codexRateLimitsSchema.shape.rateLimits),
    /** The time zone teammates plan in. */
    setTimezone: base.input(z.object({ timezone: z.string().max(100) })).output(ok),
    /** An OpenAI API key for teammates to continue on when the plan's limit is reached. */
    saveApiKey: base.input(apiKeyInputSchema).output(ok),
    removeApiKey: base.output(ok),
    /** The most the API key may spend in a month. */
    setMonthlyCap: base.input(monthlyCapInputSchema).output(ok),
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
    rate: base.input(z.object({ runId: id, rating: runRatingSchema.nullable() })).output(ok),
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
          theme: pageThemeSchema.optional(),
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
    setPhoneMode: base.input(z.object({ mode: phoneModeSchema })).output(ok),
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
    /** Send notifications to this browser, by its Web Push subscription. */
    subscribe: base
      .input(
        z.object({
          subscription: z.object({
            endpoint: z.string().url().max(2000),
            keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
          }),
          /** The browser, in words, like "Chrome on Mac". */
          device: z.string().max(200),
        }),
      )
      .output(ok),
    unsubscribe: base.input(z.object({ endpoint: z.string().max(2000) })).output(ok),
  },
};

export type Contract = typeof contract;

/** What each procedure takes, as callers write it. */
export type ApiInputs = InferContractRouterInputs<Contract>;
/** What each procedure returns. */
export type ApiOutputs = InferContractRouterOutputs<Contract>;
