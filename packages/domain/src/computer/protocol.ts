import { z } from "zod";
import { egressModeSchema } from "../egress/settings";

/** The size of every screen. Screenshots are taken at this size, so coordinates map 1:1. */
export const SCREEN = { width: 1280, height: 800 } as const;

const x = z
  .number()
  .int()
  .min(0)
  .max(SCREEN.width - 1);
const y = z
  .number()
  .int()
  .min(0)
  .max(SCREEN.height - 1);

export const computerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot") }),
  z.object({
    action: z.literal("click"),
    x,
    y,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clicks: z.number().int().min(1).max(3).default(1),
  }),
  z.object({ action: z.literal("move"), x, y }),
  z.object({ action: z.literal("drag"), fromX: x, fromY: y, toX: x, toY: y }),
  z.object({
    action: z.literal("scroll"),
    x,
    y,
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(25).default(5),
  }),
  z.object({ action: z.literal("type"), text: z.string().min(1).max(5000) }),
  z.object({ action: z.literal("key"), keys: z.string().min(1).max(100) }),
  z.object({ action: z.literal("open_url"), url: z.string().url() }),
  z.object({ action: z.literal("wait"), seconds: z.number().min(0.1).max(30) }),
]);

export type ComputerAction = z.infer<typeof computerActionSchema>;
export type ComputerActionName = ComputerAction["action"];

/** You hold a screen: from the screen view (`user`), or while a one-time code is typed (`user-code`). */
export const ownerLeaseSchema = z.object({
  kind: z.enum(["user", "user-code"]),
  since: z.string(),
  lastInputAt: z.string(),
  pausedForSafety: z.boolean().optional(),
});

/** A teammate's run holds a screen. */
export const runLeaseSchema = z.object({
  kind: z.literal("run"),
  runId: z.string(),
  teammateId: z.string(),
  teammateName: z.string(),
  since: z.string(),
  lastActionAt: z.string(),
});

/** Who currently holds a screen. `null` means it is free. */
export const leaseHolderSchema = z.union([ownerLeaseSchema, runLeaseSchema]).nullable();
export type LeaseHolder = z.infer<typeof leaseHolderSchema>;

export function isOwnerLease(holder: LeaseHolder): holder is z.infer<typeof ownerLeaseSchema> {
  return holder?.kind === "user" || holder?.kind === "user-code";
}

/** Screen ids are teammate ids, or a swarm helper's task id. */
export const screenIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Unknown screen");

export function isScreenId(value: unknown): value is string {
  return screenIdSchema.safeParse(value).success;
}

/** The run asking botd for something, so it works on that run's screen and holds its lease. */
export const runIdentitySchema = z.object({
  runId: z.string().min(1),
  teammateId: screenIdSchema,
  teammateName: z.string(),
  /** The screen it works on, when it isn't the teammate's own: a swarm helper's. */
  screenId: screenIdSchema.optional(),
});
export type RunIdentity = z.infer<typeof runIdentitySchema>;

/** Error codes botd returns for desktop actions. */
export const computerErrorCodeSchema = z.enum([
  "user_has_control",
  "desktop_busy",
  "invalid_action",
  "wrong_site",
  "failed",
]);
export type ComputerErrorCode = z.infer<typeof computerErrorCodeSchema>;

/** A desktop action botd didn't do, with a message for the teammate. */
export const computerActionErrorSchema = z.object({
  ok: z.literal(false),
  code: computerErrorCodeSchema,
  message: z.string(),
});
export type ComputerActionError = z.infer<typeof computerActionErrorSchema>;

/** Type a secret from the vault on a teammate's screen, without it passing through the teammate. */
export const computerFillRequestSchema = z.object({
  run: runIdentitySchema,
  /** botd refuses an empty or very long one with `invalid_action`. */
  secret: z.string(),
  /** The site the browser must be showing, like github.com, or null to fill anywhere. */
  site: z.string().nullable(),
});
export type ComputerFillRequest = z.infer<typeof computerFillRequestSchema>;

export const computerFillResultSchema = z.object({
  ok: z.literal(true),
  /** The addresses of the tabs showing when it filled. */
  pages: z.array(z.string()),
});
export type ComputerFillResult = z.infer<typeof computerFillResultSchema>;

/** Job portals where the apply guard stopped a submission. */
const blockedSchema = z.array(z.string()).optional();

export const computerActionResultSchema = z.object({
  ok: z.literal(true),
  /** JPEG screenshot taken after the action settled, base64 encoded. */
  screenshot: z.string(),
  /** Pointer position after the action. */
  cursor: z.object({ x: z.number(), y: z.number() }),
  /** Job portals where the apply guard stopped a submission during the action. */
  blocked: blockedSchema,
});
export type ComputerActionResult = z.infer<typeof computerActionResultSchema>;

/** The readable content of the page in front of a teammate's browser. */
export const pageContentSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  /** The text was longer and was cut. */
  truncated: z.boolean(),
  links: z.array(z.object({ text: z.string(), href: z.string() })),
});
export type PageContent = z.infer<typeof pageContentSchema>;

export const computerReadResultSchema = pageContentSchema.extend({
  ok: z.literal(true),
  /** Job portals where the apply guard stopped a submission since the last action. */
  blocked: blockedSchema,
});
export type ComputerReadResult = z.infer<typeof computerReadResultSchema>;

export const USER_HAS_CONTROL_MESSAGE =
  "The user has control of your screen. Do not use desktop tools until they hand it back. Continue with shell and file work, or end your turn and wait.";

export const processStateSchema = z.enum(["running", "starting", "stopped", "crashed"]);
export type ProcessState = z.infer<typeof processStateSchema>;

/**
 * Every teammate has its own screen on the shared computer: a display with its own desktop and browser.
 * Screens start when a teammate or you first use them and stop after a while unused.
 * Browser sign-ins are shared between all screens.
 */
export const screenStatusSchema = z.object({
  /** The teammate the screen belongs to. */
  id: z.string(),
  state: z.enum(["starting", "running", "stopping", "paused"]),
  browser: processStateSchema,
  lease: leaseHolderSchema,
});
export type ScreenStatus = z.infer<typeof screenStatusSchema>;

export const computerHealthSchema = z.object({
  ok: z.boolean(),
  bootedAt: z.string(),
  /** The Codex app-server that runs every teammate. */
  agent: processStateSchema,
  /** Screens that are running. A teammate without one gets it on first use. */
  screens: z.array(screenStatusSchema),
  egress: z.object({
    mode: egressModeSchema,
    agentOnline: z.boolean(),
    tunnelConnected: z.boolean(),
    /** The worker has sent its first `config` since botd started. */
    configured: z.boolean().optional(),
    /** Connections waiting for a device right now. */
    held: z.number().optional(),
    /** Connections refused in the last minute because no device could carry them. */
    refusedRecently: z.number().optional(),
  }),
});
export type ComputerHealth = z.infer<typeof computerHealthSchema>;

/** How the owner's hold on a screen ended. */
export const leaseReleaseReasonSchema = z.enum(["handed_back", "user_idle", "user_disconnected"]);
export type LeaseReleaseReason = z.infer<typeof leaseReleaseReasonSchema>;

/** Why a screen's lease changed. */
export const leaseChangeReasonSchema = z.enum([
  "acquired",
  ...leaseReleaseReasonSchema.options,
  "run_finished",
  "run_idle",
  "preempted",
]);
export type LeaseChangeReason = z.infer<typeof leaseChangeReasonSchema>;

/** Events botd streams to the worker over its `/events` socket. */
export const computerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("lease"),
    screenId: z.string(),
    holder: leaseHolderSchema,
    reason: leaseChangeReasonSchema.optional(),
  }),
  z.object({ type: z.literal("health"), health: computerHealthSchema }),
]);
export type ComputerEvent = z.infer<typeof computerEventSchema>;

/** A screen's VNC connection: watching it, or controlling it during a takeover. */
export type ScreenViewMode = "view" | "control";

/** Where the worker's sleep and wake controller has the computer. */
export const computerPhaseSchema = z.enum(["idle", "waking", "awake", "grace", "quiescing"]);
export type ComputerPhase = z.infer<typeof computerPhaseSchema>;

/** Where botd's own lifecycle is: asleep, awake, or on its way to one of them. */
export const computePhaseSchema = z.enum(["idle", "awake", "starting", "stopping"]);
export type ComputePhase = z.infer<typeof computePhaseSchema>;

/** Compute availability is separate from authentication and provider-confirmed sleep. */
export const computerLifecycleSchema = z.object({
  enabled: z.boolean(),
  phase: computerPhaseSchema,
  error: z.string().nullable(),
  demand: z.array(z.string()),
  changedAt: z.string(),
});
export type ComputerLifecycleStatus = z.infer<typeof computerLifecycleSchema>;
