import {
  type InferContractRouterInputs,
  type InferContractRouterOutputs,
  oc,
} from "@orpc/contract";
import {
  codeEntryResultSchema,
  computePhaseSchema,
  computerActionErrorSchema,
  computerActionResultSchema,
  computerActionSchema,
  computerFillRequestSchema,
  computerFillResultSchema,
  computerHealthSchema,
  computerReadResultSchema,
  leaseHolderSchema,
  leaseReleaseReasonSchema,
  pageCheckErrorSchema,
  pageCheckResultSchema,
  runIdentitySchema,
  screenIdSchema,
  screenStatusSchema,
  typeOnScreenSchema,
} from "@open-bot/domain";
import { z } from "zod";

/**
 * botd's HTTP API, inside the computer. Only the worker calls it, with `BOTD_TOKEN` as a bearer
 * token; botd implements it in `apps/botd/src/router.ts` and the worker calls it through
 * `ComputerClient` (`apps/worker/src/computer/client.ts`), which validates every answer.
 *
 * Each procedure has a fixed path, and its input is the JSON body. The paths and fields are part
 * of the contract: the computer and the worker deploy separately, so either side can be a version
 * older than the other for a while.
 *
 * Errors are JSON `{ error, code }` with the HTTP status. Answers a teammate should read, like
 * "the user has control", are not errors: they are `{ ok: false, code, message }` with status 200.
 *
 * The WebSockets (`BOTD_SOCKETS`) are not part of the contract; their events are
 * `computerEventSchema` in `@open-bot/domain`.
 */

export interface BotdMeta {
  /**
   * The procedure works on the computer: the worker wakes the computer for it first, and botd
   * counts it as activity while it runs, so the computer can't go to sleep in the middle of it.
   * Never set it on a status read or a lifecycle call, which must not wake the computer.
   */
  wakesComputer?: boolean;
  /** The input carries a secret (a vault value or a one-time code): errors never echo it. */
  secretInput?: boolean;
}

const base = oc.$meta<BotdMeta>({});
/** A procedure that works on the computer; see `BotdMeta.wakesComputer`. */
const work = base.meta({ wakesComputer: true });

const screen = z.object({ screenId: screenIdSchema });
/** Who controls the computer's lifecycle: one worker at a time. */
const owner = z.string().min(1).max(100);

/** What botd's sleep and wake state machine says about itself. */
export const lifecycleCapabilitiesSchema = z.object({
  /** The lifecycle protocol. A worker turns the lifecycle off for a version it doesn't know. */
  version: z.number(),
  enabled: z.boolean(),
  /** Missing when the lifecycle is off. */
  phase: computePhaseSchema.optional(),
});
export type LifecycleCapabilities = z.infer<typeof lifecycleCapabilitiesSchema>;

export const botdContract = {
  /**
   * Is botd up? The only procedure that needs no token: Railway's health check calls it.
   * Fails with 503 while the computer isn't healthy, unless the lifecycle manages it.
   */
  healthz: base
    .route({ method: "GET", path: "/healthz" })
    .output(z.object({ ok: z.literal(true) })),
  /** The computer's processes, screens and egress. A read: it never wakes the computer. */
  health: base.route({ method: "GET", path: "/health" }).output(computerHealthSchema),
  lifecycle: {
    capabilities: base
      .route({ method: "GET", path: "/lifecycle/capabilities" })
      .output(lifecycleCapabilitiesSchema),
    /** Claim the lifecycle for `owner` and say how much work it has; renewed while it lasts. */
    lease: base
      .route({ method: "POST", path: "/lifecycle/lease" })
      .input(z.object({ owner, demand: z.number().int().min(0) }))
      .output(lifecycleCapabilitiesSchema),
    /** Start everything that was stopped for sleep. 409 when the lifecycle is off. */
    ensure: base
      .route({ method: "POST", path: "/lifecycle/ensure" })
      .input(z.object({ owner }))
      .output(lifecycleCapabilitiesSchema),
    /** Stop everything so the computer can sleep. 409 while work is still running there. */
    quiesce: base
      .route({ method: "POST", path: "/lifecycle/quiesce" })
      .input(z.object({ owner }))
      .output(lifecycleCapabilitiesSchema),
  },
  computer: {
    /** Do one desktop action on the run's screen and return a screenshot of the result. */
    action: work
      .route({ method: "POST", path: "/computer/action" })
      .input(z.object({ run: runIdentitySchema, action: computerActionSchema }))
      .output(z.discriminatedUnion("ok", [computerActionResultSchema, computerActionErrorSchema])),
    /** The readable content of the page in front on the run's screen. */
    read: work
      .route({ method: "POST", path: "/computer/read" })
      .input(
        z.object({
          run: runIdentitySchema,
          /** A CSS selector to read only part of the page. */
          selector: z.string().min(1).max(500).optional(),
        }),
      )
      .output(z.discriminatedUnion("ok", [computerReadResultSchema, computerActionErrorSchema])),
    /** Type a vault secret into whatever has focus, only on its own site for a login. */
    fill: work
      .meta({ secretInput: true })
      .route({ method: "POST", path: "/computer/fill" })
      .input(computerFillRequestSchema)
      .output(z.discriminatedUnion("ok", [computerFillResultSchema, computerActionErrorSchema])),
    /** The site of the field in focus on a screen, before you type a one-time code there. */
    codeContext: work
      .route({ method: "POST", path: "/computer/code-context" })
      .input(screen)
      .output(z.object({ site: z.string().nullable() })),
    /**
     * Type a one-time code on a screen you hold. Never retried: an unknown outcome is settled by
     * the durable operation id.
     */
    type: work
      .meta({ secretInput: true })
      .route({ method: "POST", path: "/computer/type" })
      .input(typeOnScreenSchema.extend(screen.shape))
      .output(codeEntryResultSchema),
  },
  screens: {
    /** Start a screen without using it, so you can watch it. */
    start: work
      .route({ method: "POST", path: "/screens/start" })
      .input(screen)
      .output(screenStatusSchema),
    /** A teammate was removed: stop its screen and delete its browser profile. */
    forget: work
      .route({ method: "POST", path: "/screens/forget" })
      .input(screen)
      .output(z.object({ ok: z.literal(true) })),
  },
  pages: {
    /** Render a page file with no network, at a phone's and a laptop's width, and check it. */
    check: work
      .route({ method: "POST", path: "/pages/check" })
      .input(z.object({ path: z.string().min(1).max(1000) }))
      .output(z.discriminatedUnion("ok", [pageCheckResultSchema, pageCheckErrorSchema])),
  },
  leases: {
    /** A run ended: free every screen it holds. */
    releaseRun: work
      .route({ method: "POST", path: "/lease/run/release" })
      .input(z.object({ runId: z.string().min(1) }))
      .output(z.object({ released: z.boolean() })),
    // Your lease's routes were `/lease/user/*` until the run lease renamed its teammate keys to
    // `teammateId` and `teammateName`. They moved with that rename, so a worker and a computer on
    // different versions miss each other with 404 before a screen changes hands, instead of botd
    // giving you the screen and the worker failing on the answer and losing which run it interrupted.
    /** You take a screen; 409 while a one-time code is being typed there. */
    take: work
      .route({ method: "POST", path: "/lease/owner/take" })
      .input(screen)
      .output(z.object({ previous: leaseHolderSchema, holder: leaseHolderSchema })),
    /**
     * You hand a screen back. `released` is false when botd kept it, like while a code it typed
     * may still be showing; `clearCode` clears that field first.
     */
    release: work
      .route({ method: "POST", path: "/lease/owner/release" })
      .input(
        screen.extend({
          reason: leaseReleaseReasonSchema.optional(),
          clearCode: z.boolean().optional(),
        }),
      )
      .output(z.object({ released: z.boolean() })),
    /** You're still using a screen you hold, so it isn't handed back for being idle. */
    touch: work
      .route({ method: "POST", path: "/lease/owner/touch" })
      .input(screen)
      .output(z.object({ holder: leaseHolderSchema })),
  },
};

export type BotdContract = typeof botdContract;

/** What each procedure takes, as callers write it. */
export type BotdInputs = InferContractRouterInputs<BotdContract>;
/** What each procedure returns. */
export type BotdOutputs = InferContractRouterOutputs<BotdContract>;

/** botd's WebSockets, which carry streams rather than calls. Each takes `?token=`. */
export const BOTD_SOCKETS = {
  /** Lease and health events (`computerEventSchema`), current state first. */
  events: "/events",
  /** The Codex app-server's JSON-RPC, passed through. */
  codex: "/codex",
  /** The egress tunnel from the worker (`@open-bot/egress` framing). */
  egress: "/egress",
  /** noVNC for one screen: `?screen=<id>&mode=view|control`. */
  vnc: "/vnc",
} as const;
