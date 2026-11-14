// Automations: schedules, triggers and each time a trigger fired.
import { type Creator, type ScheduleKind, type TriggerKind } from "@open-bot/domain";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns";
import { connections } from "./integrations";
import { teammates } from "./teammates";

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teammateId: uuid("bot_id")
      .notNull()
      .references(() => teammates.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    kind: text("kind").$type<ScheduleKind>().notNull(),
    cron: text("cron"),
    runAt: timestamp("run_at", { withTimezone: true }),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Only tell you when there's news: a run with nothing to report doesn't notify you. */
    quiet: boolean("quiet").notNull().default(false),
    createdBy: text("created_by").$type<Creator>().notNull(),
    createdByRunId: uuid("created_by_run_id"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("schedules_due_idx").on(table.enabled, table.nextRunAt)],
);

/**
 * What wakes a teammate besides the clock: a web page that changed (a watch), or a request to its
 * webhook URL. Each firing runs in the teammate's Scheduled chat with the trigger's prompt.
 */
export const triggers = pgTable(
  "triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teammateId: uuid("bot_id")
      .notNull()
      .references(() => teammates.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TriggerKind>().notNull(),
    title: text("title").notNull(),
    /** What the teammate is asked to do when it fires. */
    prompt: text("prompt").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Watches: the page, how often to check it, and optional text to wait for. */
    url: text("url"),
    intervalMinutes: integer("interval_minutes"),
    lookFor: text("look_for"),
    /** Watches: the page's text at the last successful check. */
    snapshot: text("snapshot"),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** Watches: why the last check failed, cleared by the next one that works. */
    lastError: text("last_error"),
    /** Webhooks: the secret in the URL. */
    token: text("token"),
    /** Gmail and Calendar triggers: the connection they watch. */
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "cascade",
    }),
    /** Gmail: the search new mail must match. Calendar: which events (`guests` or `all`). */
    query: text("query"),
    /** Calendar: how many minutes before an event starts to wake the teammate. */
    leadMinutes: integer("lead_minutes"),
    /** Gmail: the mailbox's history id at the last check. */
    cursor: text("cursor"),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdBy: text("created_by").$type<Creator>().notNull(),
    createdByRunId: uuid("created_by_run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("triggers_token_unique").on(table.token),
    index("triggers_due_idx").on(table.enabled, table.nextCheckAt),
  ],
);

/**
 * What a Gmail or Calendar trigger already fired for: a message id, or an event occurrence and
 * its start, so nothing wakes a teammate twice.
 */
export const triggerFirings = pgTable(
  "trigger_firings",
  {
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.triggerId, table.key] }),
    index("trigger_firings_created_idx").on(table.createdAt),
  ],
);
