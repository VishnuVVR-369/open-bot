import {
  chatgptAuthSourceSchema,
  type ComputerHealth,
  computerLifecycleSchema,
} from "@open-bot/domain";
import { z } from "zod";
import { egressStatusSchema } from "../egress";

/** What the worker returns from its services, as the web app shows it. */

/** The ChatGPT account Codex runs as, and a device-code login in progress. */
export const codexStatusSchema = z.object({
  connected: z.boolean(),
  stale: z.boolean().optional(),
  /** "device" signs in with a code here; "host" reuses the login of the Mac running the stack. */
  authSource: chatgptAuthSourceSchema,
  account: z
    .object({
      type: z.enum(["chatgpt", "apiKey"]),
      email: z.string().nullable(),
      planType: z.string().nullable(),
    })
    .nullable(),
  /** A device-code login in progress. */
  login: z.object({ verificationUrl: z.string(), userCode: z.string() }).nullable(),
  error: z.string().nullable(),
});
export type CodexStatus = z.infer<typeof codexStatusSchema>;

/** One of ChatGPT's usage windows: how much of it is used, and when it starts over. */
export const rateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable(),
  resetsAt: z.number().nullable(),
});
export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

/**
 * ChatGPT's usage limits as last read, or null before the first read. Nested the way Codex
 * reports them, which is how web apps deployed before the contract read them.
 */
export const codexRateLimitsSchema = z.object({
  rateLimits: z
    .object({
      rateLimits: z.object({
        primary: rateLimitWindowSchema.nullable(),
        secondary: rateLimitWindowSchema.nullable(),
      }),
    })
    .nullable(),
});
export type CodexRateLimits = z.infer<typeof codexRateLimitsSchema>;

/** The worker, the computer and where the browser's traffic goes, as the status bar shows them. */
export const workerStatusSchema = z.object({
  computer: z.object({
    online: z.boolean(),
    // botd's health passes through as botd reported it; the botd contract will validate it.
    health: z.custom<ComputerHealth>().nullable(),
    /** Null when the computer never sleeps. */
    lifecycle: computerLifecycleSchema.nullable(),
  }),
  codex: codexStatusSchema,
  egress: egressStatusSchema,
});
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

/** The key browsers subscribe to web push with, and the browsers subscribed. */
export const pushStatusSchema = z.object({
  publicKey: z.string(),
  devices: z.array(z.object({ endpoint: z.string(), device: z.string(), createdAt: z.string() })),
});
export type PushStatus = z.infer<typeof pushStatusSchema>;

/** The Telegram connection and the account linked to it. */
export const telegramStatusSchema = z.object({
  connected: z.boolean(),
  /** Telegram's name for the account that sends your messages. */
  botUsername: z.string().nullable(), // vocabulary: allow
  tokenHint: z.string().nullable(),
  linked: z.boolean(),
  linkedName: z.string().nullable(),
  /** Why the connection isn't working, when it isn't. */
  problem: z.string().nullable(),
});
export type TelegramStatus = z.infer<typeof telegramStatusSchema>;

/** What connecting to a service found. */
export const connectionTestSchema = z.object({
  ok: z.boolean(),
  status: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  error: z.string().nullable(),
});
export type ConnectionTest = z.infer<typeof connectionTestSchema>;

/** What looking at a watched page, your mail or your calendar found just now. */
export const triggerCheckSchema = z.object({
  ok: z.boolean(),
  changed: z.boolean(),
  summary: z.string(),
});
export type TriggerCheck = z.infer<typeof triggerCheckSchema>;

/** A folder on the computer, without hidden files. */
export const fileListingSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      isDirectory: z.boolean(),
      modifiedAt: z.string().nullable(),
    }),
  ),
});
export type FileListing = z.infer<typeof fileListingSchema>;
