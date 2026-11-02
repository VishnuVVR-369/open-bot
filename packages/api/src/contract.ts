import {
  oc,
  type InferContractRouterInputs,
  type InferContractRouterOutputs,
} from "@orpc/contract";
import { z } from "zod";
import {
  approvalStatusSchema,
  approvalViewSchema,
  attachmentSchema,
  botSummarySchema,
  chatDataSchema,
  chatSummarySchema,
  messageViewSchema,
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

export const contract = {
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
    /**
     * Send a message. It's saved before anything else, and the teammates it's for get it exactly
     * once, even if the worker is down right now (it's delivered when the worker is back).
     */
    send: base.input(sendMessageInputSchema).output(messageViewSchema),
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
