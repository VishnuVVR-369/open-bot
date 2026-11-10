import { triggerKindSchema } from "@open-bot/domain";
import { z } from "zod";
import { runStatusSchema, runTriggerSchema } from "./views";

/** Automations as the app shows them: schedules, and the triggers (watches, webhooks, accounts). */

const isoDate = z.string();

/** The run an automation started last, to open it. */
const lastRunSchema = z.object({ id: z.string(), status: runStatusSchema, chatId: z.string() });

export const scheduleViewSchema = z.object({
  id: z.string(),
  botId: z.string(),
  title: z.string(),
  prompt: z.string(),
  kind: z.enum(["cron", "once"]),
  cron: z.string().nullable(),
  runAt: isoDate.nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  /** Only tells you when there's news. */
  quiet: z.boolean(),
  createdBy: z.enum(["user", "bot"]),
  nextRunAt: isoDate.nullable(),
  lastRunAt: isoDate.nullable(),
  lastRun: lastRunSchema.nullable(),
});
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

/** A page watch, a webhook, or a Gmail or Calendar trigger that wakes a teammate. */
export const triggerViewSchema = z.object({
  id: z.string(),
  botId: z.string(),
  kind: triggerKindSchema,
  title: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  createdBy: z.enum(["user", "bot"]),
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
