import {
  type InferContractRouterInputs,
  type InferContractRouterOutputs,
  oc,
} from "@orpc/contract";
import {
  botProfileChangesSchema,
  botProfileSchema as teammateProfileSchema,
  createBotSchema,
  createdTeammateSchema,
  isPageSourcePath,
  MAX_PAGE_SUMMARY,
  MAX_PAGE_TITLE,
  screenOperationSchema,
  skillInputSchema,
  teammateBundleSchema,
  type TeammateBundle,
  typeOnScreenSchema,
  updatedTeammateSchema,
} from "@open-bot/domain";
import { z } from "zod";
import { scheduleInputSchema, triggerInputSchema } from "../automations";
import {
  chatTitleSchema,
  decideApprovalInputSchema,
  feedbackInputSchema,
  groupTeammatesSchema,
  runRatingSchema,
  sendMessageInputSchema,
} from "../contract";
import { egressModeSchema, phoneEgressModeSchema, unavailableReasonSchema } from "../egress";
import {
  accountConnectInputSchema,
  accountConnectionChangesSchema,
  connectionInputSchema,
  emailSettingsInputSchema,
  emailStatusViewSchema,
} from "../integrations";
import { apiKeyInputSchema, monthlyCapInputSchema } from "../settings";
import { vaultItemInputSchema } from "../vault";
import { budgetInputSchema } from "../teammates";
import { taskChangesSchema, taskInputSchema } from "../tasks";
import { approvalStatusSchema, messageViewSchema, uploadViewSchema } from "../views";
import {
  codexRateLimitsSchema,
  codexStatusSchema,
  connectionTestSchema,
  fileListingSchema,
  pushStatusSchema,
  telegramStatusSchema,
  triggerCheckSchema,
  workerStatusSchema,
} from "./views";

/**
 * The worker's internal API, which only the web app (and tests) call, with the shared
 * `x-worker-secret` header. The worker implements it in `apps/worker/src/rpc/router.ts` and the
 * web app calls it with `createWorkerClient`.
 *
 * Each procedure has a fixed REST path under `/internal`, and its input is the path parameters
 * merged with the JSON body (or the query string for GET). The paths are part of the contract:
 * during a deploy the web app and the worker can run different versions, so a path or an input
 * field is only removed after no deployed web app calls it.
 *
 * Errors are JSON `{ error, code }` with the HTTP status; `error` is a message to show the owner.
 */

export interface WorkerMeta {
  /**
   * The procedure needs the computer: it is woken first if it is asleep, and kept awake until
   * the procedure finishes. Never set it on a read of status, which must not wake the computer.
   */
  wakesComputer?: boolean;
  /** The input carries a secret, like a one-time code: errors never echo it back. */
  secretInput?: boolean;
}

const base = oc.$meta<WorkerMeta>({});
/** A procedure that needs the computer awake; see `WorkerMeta.wakesComputer`. */
const computer = base.meta({ wakesComputer: true });

const id = z.string().uuid();
const ok = z.object({ ok: z.literal(true) });

// The owner's inputs, shared with the app's API; still exported here for the worker.
export {
  scheduleInputSchema,
  triggerInputSchema,
  type ScheduleInput,
  type TriggerInput,
} from "../automations";
export { taskStatusSchema } from "../tasks";

export const workerContract = {
  status: {
    /** Never wakes the computer: it reports whether it is awake. */
    get: base.route({ method: "GET", path: "/internal/status" }).output(workerStatusSchema),
  },
  teammates: {
    /** The same service that creates a teammate when another teammate asks to. */
    create: base
      .route({ method: "POST", path: "/internal/bots" })
      .input(createBotSchema)
      .output(createdTeammateSchema),
    /** Refused with 409 when `expected_revision` is not the teammate's revision now. */
    update: base
      .route({ method: "POST", path: "/internal/bots/{teammateId}" })
      .input(
        z.object({
          teammateId: id,
          changes: botProfileChangesSchema,
          expected_revision: z.string().min(1).max(128),
        }),
      )
      .output(updatedTeammateSchema),
    /** The teammate as a file (`teammateBundleSchema`), and its slug for the file name. */
    export: base
      .route({ method: "GET", path: "/internal/teammates/{teammateId}/export" })
      .input(z.object({ teammateId: id }))
      // Everything the teammate has, as it is: a file can hold more than one may import.
      .output(
        z.object({
          slug: z.string(),
          bundle: z.custom<TeammateBundle>((value) => typeof value === "object" && value !== null),
        }),
      ),
    /**
     * A new teammate set up like another; its routines, watches and reminders start paused.
     * Memory and lessons come along with `copyMemory`.
     */
    duplicate: base
      .route({ method: "POST", path: "/internal/teammates/{teammateId}/duplicate" })
      .input(
        z.object({
          teammateId: id,
          name: teammateProfileSchema.shape.name,
          copyMemory: z.boolean(),
        }),
      )
      .output(z.object({ teammateId: z.string(), chatId: z.string(), memoryCopied: z.boolean() })),
    /** A new teammate from an exported file; its routines and page watches start paused. */
    import: base
      .route({ method: "POST", path: "/internal/teammates/import" })
      .input(z.object({ bundle: teammateBundleSchema }))
      .output(
        z.object({
          teammateId: z.string(),
          chatId: z.string(),
          name: z.string(),
          paused: z.number().int().nonnegative(),
        }),
      ),
    /** Make this teammate the lead. */
    setLead: base
      .route({ method: "POST", path: "/internal/teammates/{teammateId}/lead" })
      .input(z.object({ teammateId: id }))
      .output(ok),
    /**
     * Archive a teammate and stop its work. Never wakes the computer to answer; its screen is
     * forgotten on the way, waking the computer for that only.
     */
    archive: base
      .route({ method: "POST", path: "/internal/teammates/{teammateId}/archive" })
      .input(z.object({ teammateId: id }))
      .output(ok),
    setBudget: base
      .route({ method: "POST", path: "/internal/teammates/{teammateId}/budget" })
      .input(budgetInputSchema)
      .output(ok),
    /** Write the teammate's workspace (AGENTS.md, skills) on the computer now. */
    sync: computer
      .route({ method: "POST", path: "/internal/bots/{teammateId}/sync" })
      .input(z.object({ teammateId: id }))
      .output(ok),
  },
  proposals: {
    /** Take suggested instructions; the same decision again succeeds, the other is a 409. */
    accept: base
      .route({ method: "POST", path: "/internal/proposals/{proposalId}/accept" })
      .input(z.object({ proposalId: id }))
      .output(ok),
    dismiss: base
      .route({ method: "POST", path: "/internal/proposals/{proposalId}/dismiss" })
      .input(z.object({ proposalId: id }))
      .output(ok),
  },
  chats: {
    /** Start a new direct chat with a teammate. */
    newDirect: base
      .route({ method: "POST", path: "/internal/chats/direct" })
      .input(z.object({ teammateId: id }))
      .output(z.object({ chatId: z.string() })),
    /** Start a group chat with two or more teammates. */
    createGroup: base
      .route({ method: "POST", path: "/internal/chats/group" })
      .input(z.object({ title: chatTitleSchema, teammateIds: groupTeammatesSchema }))
      .output(z.object({ chatId: z.string() })),
    rename: base
      .route({ method: "POST", path: "/internal/chats/{chatId}/rename" })
      .input(z.object({ chatId: id, title: chatTitleSchema }))
      .output(ok),
    /** Hide a chat from the lists. Its history stays. */
    archive: base
      .route({ method: "POST", path: "/internal/chats/{chatId}/archive" })
      .input(z.object({ chatId: id }))
      .output(ok),
    /** The owner has seen what's in the chat. */
    markRead: base
      .route({ method: "POST", path: "/internal/chats/{chatId}/read" })
      .input(z.object({ chatId: id }))
      .output(ok),
    /**
     * Save a message the owner sent and deliver it. 409 when its `clientId` was used for a
     * different message; the same message again returns it and delivers it again.
     */
    send: base
      .route({ method: "POST", path: "/internal/chats/{chatId}/messages" })
      .input(sendMessageInputSchema)
      .output(messageViewSchema),
  },
  messages: {
    /** Deliver a saved message to the teammates it is for. Safe to call again. */
    dispatch: base
      .route({ method: "POST", path: "/internal/messages/{messageId}/dispatch" })
      .input(z.object({ messageId: id }))
      .output(ok),
  },
  runs: {
    /** Run a finished run's request again; asked again after that, it returns the new run. */
    retry: base
      .route({ method: "POST", path: "/internal/runs/{runId}/retry" })
      .input(z.object({ runId: id }))
      .output(z.object({ runId: z.string() })),
    /** Stop the runs the owner marked as cancelled in the database. */
    processCancellations: base.route({ method: "POST", path: "/internal/runs/cancel" }).output(ok),
    /** Stop a run. */
    stop: base
      .route({ method: "POST", path: "/internal/runs/{runId}/stop" })
      .input(z.object({ runId: id }))
      .output(ok),
    rate: base
      .route({ method: "POST", path: "/internal/runs/{runId}/rate" })
      .input(z.object({ runId: id, rating: runRatingSchema }))
      .output(ok),
    /**
     * A thumbs down with what to change: kept as a lesson with `remember`, and with `redo` sent to
     * the chat as a new message. 409 when the redo's `clientId` was used for something else.
     */
    feedback: base
      .route({ method: "POST", path: "/internal/runs/{runId}/feedback" })
      .input(feedbackInputSchema)
      .output(ok),
  },
  approvals: {
    /** Says how the approval ended, also when it was decided elsewhere first or expired. */
    decide: base
      .route({ method: "POST", path: "/internal/approvals/{approvalId}/decide" })
      .input(decideApprovalInputSchema.partial({ alwaysAllow: true }))
      .output(z.object({ decided: z.boolean(), status: approvalStatusSchema })),
    removeRule: base
      .route({ method: "POST", path: "/internal/approval-rules/{ruleId}/delete" })
      .input(z.object({ ruleId: id }))
      .output(ok),
  },
  screens: {
    wake: computer
      .route({ method: "POST", path: "/internal/screens/{screenId}/wake" })
      .input(z.object({ screenId: id }))
      .output(ok),
    forget: computer
      .route({ method: "POST", path: "/internal/screens/{screenId}/forget" })
      .input(z.object({ screenId: id }))
      .output(ok),
    take: computer
      .route({ method: "POST", path: "/internal/screens/{screenId}/take" })
      .input(z.object({ screenId: id }))
      .output(ok),
    handBack: computer
      .route({ method: "POST", path: "/internal/screens/{screenId}/hand-back" })
      .input(
        z.object({
          screenId: id,
          note: z.string().max(2000).nullable().optional(),
          clearCode: z.boolean().optional(),
        }),
      )
      .output(ok),
    /** The owner is using the screen, so it isn't handed back for being idle. */
    touch: computer
      .route({ method: "POST", path: "/internal/screens/{screenId}/touch" })
      .input(z.object({ screenId: id }))
      .output(ok),
    /** Type a one-time code on the screen a takeover is for. */
    typeCode: computer
      .meta({ secretInput: true })
      .route({ method: "POST", path: "/internal/screens/code" })
      .input(typeOnScreenSchema)
      .output(screenOperationSchema),
  },
  screenOperations: {
    get: base
      .route({ method: "GET", path: "/internal/screen-operations/{operationId}" })
      .input(z.object({ operationId: id }))
      .output(screenOperationSchema.nullable()),
    cancel: base
      .route({ method: "POST", path: "/internal/screen-operations/{operationId}/cancel" })
      .input(z.object({ operationId: id }))
      .output(screenOperationSchema),
  },
  takeovers: {
    /** Which screen and site a code typed for this takeover would go to. */
    codeContext: computer
      .route({ method: "GET", path: "/internal/takeover/{takeoverId}/code-context" })
      .input(z.object({ takeoverId: id }))
      .output(z.object({ screenId: z.string(), site: z.string().nullable() })),
    dismiss: base
      .route({ method: "POST", path: "/internal/takeover/{takeoverId}/dismiss" })
      .input(z.object({ takeoverId: id }))
      .output(ok),
  },
  files: {
    /** Only paths inside `/home/bot`, outside Codex's private folder. */
    list: computer
      .route({ method: "GET", path: "/internal/files/list" })
      .input(z.object({ path: z.string().optional() }))
      .output(fileListingSchema),
    read: computer
      .route({ method: "GET", path: "/internal/files/read" })
      .input(z.object({ path: z.string() }))
      .output(z.object({ path: z.string(), dataBase64: z.string() })),
    write: computer
      .route({ method: "POST", path: "/internal/files/write" })
      .input(z.object({ path: z.string(), dataBase64: z.string() }))
      .output(ok),
    /** Add a file to a folder; a name that is taken becomes "name (2).ext". */
    put: computer
      .route({ method: "POST", path: "/internal/files/put" })
      .input(z.object({ dir: z.string(), name: z.string().min(1), dataBase64: z.string() }))
      .output(z.object({ path: z.string() })),
    /** Refused for folders the system needs, like an active teammate's workspace. */
    remove: computer
      .route({ method: "POST", path: "/internal/files/remove" })
      .input(z.object({ path: z.string() }))
      .output(ok),
  },
  pages: {
    /** Pin or unpin a page. */
    pin: base
      .route({ method: "POST", path: "/internal/pages/{pageId}/pin" })
      .input(z.object({ pageId: id, pinned: z.boolean() }))
      .output(ok),
    /** Delete a page and its versions. */
    remove: base
      .route({ method: "POST", path: "/internal/pages/{pageId}/delete" })
      .input(z.object({ pageId: id }))
      .output(ok),
    /**
     * Check and publish a page from a file on the computer, the way publish_page does but
     * outside a run: for setting up pages, and for tests that need a real one.
     */
    publish: computer
      .route({ method: "POST", path: "/internal/pages/publish" })
      .input(
        z.object({
          botId: id,
          chatId: id.nullable().default(null),
          path: z
            .string()
            .refine(isPageSourcePath, "Use an .html file in a workspace or the shared folder."),
          title: z.string().trim().min(1).max(MAX_PAGE_TITLE),
          summary: z.string().max(MAX_PAGE_SUMMARY).default(""),
          note: z.string().max(1000).default(""),
          pageId: id.optional(),
        }),
      )
      .output(
        z.object({
          pageId: z.string(),
          versionId: z.string(),
          version: z.number().int(),
          warnings: z.array(z.string()),
        }),
      ),
  },
  uploads: {
    /**
     * How an upload went. The upload itself is `PUT /internal/uploads/{uploadId}` with the raw
     * bytes, outside this contract, so a large file streams through without being buffered.
     */
    status: base
      .route({ method: "GET", path: "/internal/uploads/{uploadId}" })
      .input(z.object({ uploadId: id }))
      .output(uploadViewSchema),
  },
  schedules: {
    create: base
      .route({ method: "POST", path: "/internal/schedules" })
      .input(scheduleInputSchema)
      .output(z.object({ id: z.string() })),
    update: base
      .route({ method: "POST", path: "/internal/schedules/{scheduleId}" })
      .input(scheduleInputSchema.extend({ scheduleId: id }))
      .output(z.object({ id: z.string() })),
    setEnabled: base
      .route({ method: "POST", path: "/internal/schedules/{scheduleId}/enabled" })
      .input(z.object({ scheduleId: id, enabled: z.boolean() }))
      .output(ok),
    /** Delete it; one already gone is fine. */
    remove: base
      .route({ method: "POST", path: "/internal/schedules/{scheduleId}/delete" })
      .input(z.object({ scheduleId: id }))
      .output(ok),
    /** Run it now, without changing when it runs next. */
    runNow: base
      .route({ method: "POST", path: "/internal/schedules/{scheduleId}/run" })
      .input(z.object({ scheduleId: id }))
      .output(ok),
  },
  push: {
    /** The key browsers subscribe with, and the browsers subscribed. */
    status: base.route({ method: "GET", path: "/internal/push" }).output(pushStatusSchema),
    subscribe: base
      .route({ method: "POST", path: "/internal/push/subscribe" })
      .input(
        z.object({
          subscription: z.object({
            endpoint: z.string().url().max(2000),
            keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
          }),
          device: z.string().max(200).default(""),
        }),
      )
      .output(ok),
    unsubscribe: base
      .route({ method: "POST", path: "/internal/push/unsubscribe" })
      .input(z.object({ endpoint: z.string() }))
      .output(ok),
    /** Notify every browser and phone; returns how many were sent. */
    test: base
      .route({ method: "POST", path: "/internal/push/test" })
      .output(z.object({ sent: z.number().int().nonnegative() })),
    registerNative: base
      .route({ method: "POST", path: "/internal/push/native/register" })
      .input(
        z.object({
          token: z.string().min(1).max(4096),
          platform: z.literal("android"),
          device: z.string().max(200).default(""),
        }),
      )
      .output(ok),
    unregisterNative: base
      .route({ method: "POST", path: "/internal/push/native/unregister" })
      .input(z.object({ token: z.string().min(1).max(4096) }))
      .output(ok),
  },
  tasks: {
    create: base
      .route({ method: "POST", path: "/internal/tasks" })
      .input(taskInputSchema)
      .output(z.object({ id: z.string() })),
    update: base
      .route({ method: "POST", path: "/internal/tasks/{taskId}" })
      .input(taskChangesSchema.extend({ taskId: id }))
      .output(ok),
    remove: base
      .route({ method: "POST", path: "/internal/tasks/{taskId}/delete" })
      .input(z.object({ taskId: id }))
      .output(ok),
    /** Hand the task to its teammate in a new chat. */
    start: base
      .route({ method: "POST", path: "/internal/tasks/{taskId}/start" })
      .input(z.object({ taskId: id }))
      .output(z.object({ chatId: z.string().nullable() })),
  },
  email: {
    /** Mail Postmark delivered to a teammate's address; `token` is the secret in the URL. */
    inbound: base
      .route({
        method: "POST",
        path: "/internal/email/inbound/{token}",
        // The body is Postmark's payload as it came, so it isn't merged with the path.
        inputStructure: "detailed",
      })
      .input(z.object({ params: z.object({ token: z.string() }), body: z.unknown() }))
      .output(z.object({ ok: z.literal(true), botId: z.string().nullable() })),
    /** The domain, the inbound address and each teammate's address (makes the email row once). */
    status: base.route({ method: "GET", path: "/internal/email" }).output(emailStatusViewSchema),
    /** The domain teammates' addresses are on, and Postmark's token (empty keeps the saved one). */
    save: base
      .route({ method: "POST", path: "/internal/email" })
      .input(emailSettingsInputSchema)
      .output(ok),
    /** Forget Postmark's token: teammates receive email but can't send it. */
    removeToken: base.route({ method: "POST", path: "/internal/email/token/delete" }).output(ok),
  },
  vault: {
    /** Save a login or card: a new one, or with `id`, a change to one. Its secret is encrypted. */
    save: base
      .route({ method: "POST", path: "/internal/vault" })
      .input(vaultItemInputSchema)
      .output(z.object({ id: z.string() })),
    remove: base
      .route({ method: "POST", path: "/internal/vault/{itemId}/delete" })
      .input(z.object({ itemId: id }))
      .output(ok),
  },
  notifications: {
    /** Mark these notifications read, or every one up to `through`, or all of them. */
    markRead: base
      .route({ method: "POST", path: "/internal/notifications/read" })
      .input(z.object({ ids: z.array(id).max(200).optional(), through: id.optional() }))
      .output(ok),
  },
  settings: {
    /** The time zone teammates plan in. */
    setTimezone: base
      .route({ method: "POST", path: "/internal/settings/timezone" })
      .input(z.object({ timezone: z.string().max(100) }))
      .output(ok),
    /** The most the API key may spend in a month. */
    setMonthlyCap: base
      .route({ method: "POST", path: "/internal/settings/monthly-cap" })
      .input(monthlyCapInputSchema)
      .output(ok),
    /** The OpenAI API key teammates continue on when the plan's limit is reached. */
    saveApiKey: base
      .route({ method: "POST", path: "/internal/settings/api-key" })
      .input(apiKeyInputSchema)
      .output(ok),
    removeApiKey: base
      .route({ method: "POST", path: "/internal/settings/api-key/delete" })
      .output(ok),
  },
  connections: {
    /** Save an MCP server: a new one, or with `id`, a change to one. */
    save: base
      .route({ method: "POST", path: "/internal/connections" })
      .input(connectionInputSchema)
      .output(z.object({ id: z.string() })),
    /** Turn a connection on or off. Turning an account off cancels what waits on it. */
    setEnabled: base
      .route({ method: "POST", path: "/internal/connections/{connectionId}/enabled" })
      .input(z.object({ connectionId: id, enabled: z.boolean() }))
      .output(ok),
    /** Remove a connection; the last one using an account revokes it at the provider. */
    remove: base
      .route({ method: "POST", path: "/internal/connections/{connectionId}/delete" })
      .input(z.object({ connectionId: id }))
      .output(z.object({ warning: z.string().nullable() })),
    /** Change what an account connection allows, who uses it and how it asks. */
    updateAccount: base
      .route({ method: "POST", path: "/internal/connections/{connectionId}/account" })
      .input(accountConnectionChangesSchema)
      .output(z.object({ needsConsent: z.boolean() })),
    /**
     * You signed in to an account (the web app saved its grant): its connection of `kind`, made or
     * changed to what you picked. What waits on an earlier grant is cancelled.
     */
    linkAccount: base
      .route({ method: "POST", path: "/internal/accounts/{accountId}/linked" })
      .input(
        accountConnectInputSchema
          .pick({ kind: true, capabilities: true, teammateIds: true })
          .extend({ accountId: id }),
      )
      .output(z.object({ connectionId: z.string() })),
    /** Connect to an MCP server or account from the computer and list its tools. */
    test: computer
      .route({ method: "POST", path: "/internal/connections/{connectionId}/test" })
      .input(z.object({ connectionId: id }))
      .output(connectionTestSchema),
  },
  swarms: {
    /** Stop every helper in a swarm. */
    stop: base
      .route({ method: "POST", path: "/internal/swarms/{swarmId}/stop" })
      .input(z.object({ swarmId: id }))
      .output(ok),
  },
  triggers: {
    create: base
      .route({ method: "POST", path: "/internal/triggers" })
      .input(triggerInputSchema)
      .output(z.object({ id: z.string(), hookPath: z.string().nullable() })),
    update: base
      .route({ method: "POST", path: "/internal/triggers/{triggerId}" })
      .input(triggerInputSchema.extend({ triggerId: id }))
      .output(z.object({ id: z.string() })),
    setEnabled: base
      .route({ method: "POST", path: "/internal/triggers/{triggerId}/enabled" })
      .input(z.object({ triggerId: id, enabled: z.boolean() }))
      .output(ok),
    remove: base
      .route({ method: "POST", path: "/internal/triggers/{triggerId}/delete" })
      .input(z.object({ triggerId: id }))
      .output(ok),
    /** Look at the watched page, mail or calendar now. */
    check: base
      .route({ method: "POST", path: "/internal/triggers/{triggerId}/check" })
      .input(z.object({ triggerId: id }))
      .output(triggerCheckSchema),
    /** Give a webhook a new URL. The old one stops working. */
    rotateToken: base
      .route({ method: "POST", path: "/internal/triggers/{triggerId}/rotate" })
      .input(z.object({ triggerId: id }))
      .output(z.object({ token: z.string() })),
  },
  hooks: {
    /**
     * A service called a webhook. Fails with 404 for an unknown webhook, 409 when it is paused or
     * its teammate is archived, and 429 when it already started too many runs this hour.
     */
    fire: base
      .route({ method: "POST", path: "/internal/hooks/{token}" })
      .input(
        z.object({
          token: z.string(),
          method: z.string().max(10),
          contentType: z.string().max(200),
          body: z.string().max(512 * 1024),
          query: z.string().max(4000),
        }),
      )
      .output(z.object({ runId: z.string() })),
  },
  telegram: {
    status: base.route({ method: "GET", path: "/internal/telegram" }).output(telegramStatusSchema),
    connect: base
      .route({ method: "POST", path: "/internal/telegram/connect" })
      .input(z.object({ token: z.string().max(200) }))
      .output(telegramStatusSchema),
    /** A code to send the bot from the Telegram account to link. */
    linkCode: base
      .route({ method: "POST", path: "/internal/telegram/link-code" })
      .output(z.object({ code: z.string(), url: z.string(), expiresAt: z.string() })),
    sendTest: base.route({ method: "POST", path: "/internal/telegram/test" }).output(ok),
    unlink: base.route({ method: "POST", path: "/internal/telegram/unlink" }).output(ok),
    disconnect: base.route({ method: "POST", path: "/internal/telegram/disconnect" }).output(ok),
  },
  skills: {
    /** Create a skill, or with `id`, change one. */
    save: base
      .route({ method: "POST", path: "/internal/skills" })
      .input(skillInputSchema.extend({ id: id.nullable().optional() }))
      .output(z.object({ id: z.string() })),
    remove: base
      .route({ method: "POST", path: "/internal/skills/{skillId}/delete" })
      .input(z.object({ skillId: id }))
      .output(ok),
  },
  codex: {
    /** Start a device-code sign-in to ChatGPT. */
    deviceLogin: computer
      .route({ method: "POST", path: "/internal/codex/device-login" })
      .output(z.object({ verificationUrl: z.string(), userCode: z.string() })),
    /** Sign in with a device code, or with the login of the Mac running the stack. */
    setAuthSource: computer
      .route({ method: "POST", path: "/internal/codex/auth-source" })
      .input(z.object({ source: z.enum(["device", "host"]) }))
      .output(codexStatusSchema),
    logout: computer.route({ method: "POST", path: "/internal/codex/logout" }).output(ok),
    /** ChatGPT's usage limits, as last read; reading them never wakes the computer. */
    rateLimits: base
      .route({ method: "GET", path: "/internal/codex/rate-limits" })
      .output(codexRateLimitsSchema),
  },
  egress: {
    setMode: base
      .route({ method: "POST", path: "/internal/egress/mode" })
      .input(z.object({ mode: egressModeSchema }))
      .output(ok),
    setPhoneMode: base
      .route({ method: "POST", path: "/internal/egress/phone-mode" })
      .input(z.object({ mode: phoneEgressModeSchema }))
      .output(ok),
    /** Phones were paired, renamed or revoked: read them again. */
    devicesChanged: base
      .route({ method: "POST", path: "/internal/egress/devices/changed" })
      .output(ok),
    /** A phone can't carry traffic right now. Ignored unless `generation` is its pairing now. */
    deviceUnavailable: base
      .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/unavailable" })
      .input(
        z.object({
          deviceId: id,
          reason: unavailableReasonSchema,
          generation: z.number().int().positive(),
          seq: z.number().int().nonnegative().optional(),
        }),
      )
      .output(ok),
    /** Drop a phone's tunnel, unless it was paired again since `generation`. */
    deviceRevoked: base
      .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/revoked" })
      .input(z.object({ deviceId: id, generation: z.number().int().nonnegative() }))
      .output(ok),
    /**
     * Pair a phone, or pair it again with a new secret and generation. The secret is in the answer
     * once; only its hash is kept.
     */
    pairDevice: base
      .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/pair" })
      .input(
        z.object({
          deviceId: id,
          name: z.string().trim().min(1).max(80),
          pushToken: z.string().min(1).max(4096).nullable(),
        }),
      )
      .output(z.object({ secret: z.string(), generation: z.number().int().positive() })),
    /** Unpair a phone; with `generation`, only that pairing. */
    unpairDevice: base
      .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/unpair" })
      .input(z.object({ deviceId: id, generation: z.number().int().positive().optional() }))
      .output(ok),
    /** A paired phone's new FCM token, to wake it with. */
    devicePushToken: base
      .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/push-token" })
      .input(z.object({ deviceId: id, token: z.string().min(1).max(4096) }))
      .output(ok),
    /** A paired phone asked to open the tunnel. */
    deviceUsed: base
      .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/used" })
      .input(z.object({ deviceId: id }))
      .output(ok),
  },
};

export type WorkerContract = typeof workerContract;
/** What each worker procedure takes, as callers write it. */
export type WorkerInputs = InferContractRouterInputs<WorkerContract>;
/** What each worker procedure returns. */
export type WorkerOutputs = InferContractRouterOutputs<WorkerContract>;
