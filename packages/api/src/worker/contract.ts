import {
  type InferContractRouterInputs,
  type InferContractRouterOutputs,
  oc,
} from "@orpc/contract";
import {
  botProfileChangesSchema,
  createBotSchema,
  createdTeammateSchema,
  isPageSourcePath,
  MAX_PAGE_SUMMARY,
  MAX_PAGE_TITLE,
  screenOperationSchema,
  skillInputSchema,
  typeOnScreenSchema,
  updatedTeammateSchema,
} from "@open-bot/domain";
import { z } from "zod";
import { scheduleInputSchema, triggerInputSchema } from "../automations";
import { decideApprovalInputSchema } from "../contract";
import { egressModeSchema, phoneEgressModeSchema, unavailableReasonSchema } from "../egress";
import { taskChangesSchema, taskInputSchema } from "../tasks";
import { approvalStatusSchema, uploadViewSchema } from "../views";
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
    /** Write the teammate's workspace (AGENTS.md, skills) on the computer now. */
    sync: computer
      .route({ method: "POST", path: "/internal/bots/{teammateId}/sync" })
      .input(z.object({ teammateId: id }))
      .output(ok),
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
      .input(
        taskChangesSchema.extend({ taskId: id }),
      )
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
  },
  connections: {
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
  },
};

export type WorkerContract = typeof workerContract;
/** What each worker procedure takes, as callers write it. */
export type WorkerInputs = InferContractRouterInputs<WorkerContract>;
/** What each worker procedure returns. */
export type WorkerOutputs = InferContractRouterOutputs<WorkerContract>;
