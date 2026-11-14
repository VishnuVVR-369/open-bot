import {
  creatorSchema,
  runStatusSchema,
  runTriggerSchema,
  scheduleKindSchema,
  triggerKindSchema,
} from "@open-bot/domain";
import { z } from "zod";
import { id } from "./base";

/** Automations as the app shows them: schedules, and the triggers (watches, webhooks, accounts). */

const isoDate = z.string();

/** The run an automation started last, to open it. */
const lastRunSchema = z.object({ id: z.string(), status: runStatusSchema, chatId: z.string() });

export const scheduleViewSchema = z.object({
  id: z.string(),
  teammateId: z.string(),
  title: z.string(),
  prompt: z.string(),
  kind: scheduleKindSchema,
  cron: z.string().nullable(),
  runAt: isoDate.nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  /** Only tells you when there's news. */
  quiet: z.boolean(),
  createdBy: creatorSchema,
  nextRunAt: isoDate.nullable(),
  lastRunAt: isoDate.nullable(),
  lastRun: lastRunSchema.nullable(),
});
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

/** A page watch, a webhook, or a Gmail or Calendar trigger that wakes a teammate. */
export const triggerViewSchema = z.object({
  id: z.string(),
  teammateId: z.string(),
  kind: triggerKindSchema,
  title: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  createdBy: creatorSchema,
  url: z.string().nullable(),
  intervalMinutes: z.number().nullable(),
  lookFor: z.string().nullable(),
  /** Gmail and Calendar: the connection watched, and its account's address. */
  connectionId: z.string().nullable(),
  account: z.string().nullable(),
  /** Gmail: the search new mail must match. Calendar: `all` or `guests`. */
  query: z.string().nullable(),
  /** Calendar: how many minutes before an event it wakes the teammate. */
  leadMinutes: z.number().nullable(),
  /** Webhooks: the path services call, without the origin. */
  hookPath: z.string().nullable(),
  nextCheckAt: isoDate.nullable(),
  lastCheckedAt: isoDate.nullable(),
  lastError: z.string().nullable(),
  lastFiredAt: isoDate.nullable(),
  lastRun: lastRunSchema.nullable(),
});
export type TriggerView = z.infer<typeof triggerViewSchema>;

/** One time a schedule, watch or webhook ran. */
export const automationRunViewSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: runStatusSchema,
  trigger: runTriggerSchema,
  preview: z.string().nullable(),
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
});
export type AutomationRunView = z.infer<typeof automationRunViewSchema>;

/** A routine (cron) or a reminder (at) a teammate runs, as the owner sets it up. */
export const scheduleInputSchema = z.object({
  teammateId: id,
  title: z.string().min(1).max(80),
  prompt: z.string().min(1).max(4000),
  cron: z.string().nullable(),
  at: z.string().nullable(),
  /** Null uses the owner's time zone. */
  timezone: z.string().nullable(),
  /** Only tell the owner when there's news. Left out on an edit, it stays as it was. */
  quiet: z.boolean().optional(),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

/** A watch, webhook, Gmail or Calendar trigger, as the owner sets it up. */
export const triggerInputSchema = z.object({
  teammateId: id,
  kind: triggerKindSchema,
  title: z.string().max(200),
  prompt: z.string().max(8000),
  /** Watches: the page to look at. */
  url: z.string().max(2000).nullable().optional(),
  intervalMinutes: z.number().int().nullable().optional(),
  /** Watches: what change to wake for, in words. */
  lookFor: z.string().max(400).nullable().optional(),
  /** Gmail and Calendar: the connection to watch. */
  connectionId: id.nullable().optional(),
  /** Gmail: the search new mail must match (empty for all of it). Calendar: `all` or `guests`. */
  query: z.string().max(1000).nullable().optional(),
  /** Calendar: how many minutes before an event to wake the teammate. */
  leadMinutes: z.number().int().nullable().optional(),
});
export type TriggerInput = z.infer<typeof triggerInputSchema>;
