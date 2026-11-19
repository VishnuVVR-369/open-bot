// Runs: queued teammate work, its timeline events and the files it made.
import {
  AUTH_MODES,
  type AuthMode,
  type RunEventPayload,
  type RunRating,
  type RunLane,
  type RunStatus,
  type RunTrigger,
  type RunWait,
} from "@open-bot/domain";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { type Attachment, chats, messages } from "./chats";
import { bytea, createdAt, oneOf } from "./columns";
import { bots } from "./teammates";

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    trigger: text("trigger").$type<RunTrigger>().notNull(),
    lane: text("lane").$type<RunLane>().notNull().default("chat"),
    /** A quiet routine finished with nothing to report. */
    quiet: boolean("quiet").notNull().default(false),
    /** When the conversation received this other lane's result. */
    passedOnAt: timestamp("passed_on_at", { withTimezone: true }),
    /** The text sent to the bot to start this run. */
    prompt: text("prompt").notNull(),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    scheduleId: uuid("schedule_id"),
    /** The watch or webhook that started this run. */
    triggerId: uuid("trigger_id"),
    parentRunId: uuid("parent_run_id"),
    /** The screen it works on when it isn't its bot's own, like a swarm helper's. */
    screenId: uuid("screen_id"),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    waitingFor: text("waiting_for").$type<RunWait>(),
    error: text("error"),
    authMode: text("auth_mode").$type<AuthMode>(),
    codexThreadId: text("codex_thread_id"),
    codexTurnId: text("codex_turn_id"),
    finalText: text("final_text"),
    /** Your thumbs up or down on the reply. */
    rating: text("rating").$type<RunRating>(),
    /** Set when you press stop, so the worker interrupts the turn. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    /**
     * It read mail, events or pages from your accounts, or was started by something that did.
     * Everything such a run sends out asks you first, whatever the teammate's autonomy.
     */
    readOutsideData: boolean("read_outside_data").notNull().default(false),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Legacy usage: what `usage_entries` held for the run, per access mode, copied by migration
    // 0040, by its trigger on each entry written since, and again by 0041, which then dropped
    // `usage_entries`. Code never writes these. They are the usage a worker that still wrote
    // `usage_entries` counted for the run; the model requests it logged leave `counts_usage`
    // false, so they never count again. Null for a mode the run had no entry for.
    legacyPlanInputTokens: bigint("legacy_plan_input_tokens", { mode: "number" }),
    legacyPlanCachedInputTokens: bigint("legacy_plan_cached_input_tokens", { mode: "number" }),
    legacyPlanOutputTokens: bigint("legacy_plan_output_tokens", { mode: "number" }),
    legacyPlanCostMicros: bigint("legacy_plan_cost_micros", { mode: "number" }),
    legacyApiKeyInputTokens: bigint("legacy_api_key_input_tokens", { mode: "number" }),
    legacyApiKeyCachedInputTokens: bigint("legacy_api_key_cached_input_tokens", {
      mode: "number",
    }),
    legacyApiKeyOutputTokens: bigint("legacy_api_key_output_tokens", { mode: "number" }),
    legacyApiKeyCostMicros: bigint("legacy_api_key_cost_micros", { mode: "number" }),
    /**
     * When the legacy totals were counted: the API key entry's time, else the plan entry's (both
     * were written as the run finished). It puts them in a month for the cap and Settings.
     */
    legacyUsageAt: timestamp("legacy_usage_at", { withTimezone: true }),
  },
  (table) => [
    index("runs_chat_idx").on(table.chatId, table.createdAt),
    // This month's legacy totals, for the cap and Settings' usage.
    index("runs_legacy_usage_idx")
      .on(table.legacyUsageAt)
      .where(sql`${table.legacyUsageAt} is not null`),
    index("runs_status_idx").on(table.status),
    // Newest first, a page at a time, keyed by (created_at, id) (model logs' runs list).
    index("runs_created_idx").on(table.createdAt, table.id),
    index("runs_bot_idx").on(table.botId, table.createdAt),
    index("runs_trigger_idx").on(table.triggerId, table.createdAt),
    // Upload cleanup asks which runs carry a file.
    index("runs_attachments_idx").using("gin", table.attachments.op("jsonb_path_ops")),
    // A message you sent starts at most one run per teammate.
    uniqueIndex("runs_user_message_unique")
      .on(table.messageId, table.botId)
      .where(sql`${table.trigger} = 'user' and ${table.messageId} is not null`),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<RunEventPayload>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("run_events_chat_idx").on(table.chatId, table.id),
    index("run_events_run_idx").on(table.runId, table.id),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"screenshot" | "upload">().notNull(),
    mime: text("mime").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: createdAt(),
  },
  // A run's screenshots, newest first: each screen's last frame, and deleting a run.
  (table) => [index("artifacts_run_idx").on(table.runId, table.createdAt)],
);

/**
 * Legacy usage of runs that were deleted: `usage_entries` rows whose run was already gone when
 * migration 0040 copied them, and the legacy totals of a run deleted since, which the
 * `runs_keep_legacy_usage` trigger moves here. This month's rows keep counting toward the cap and
 * Settings' usage, as the entries did. Only migrations and their triggers write it.
 */
export const legacyDeletedRunUsage = pgTable(
  "legacy_deleted_run_usage",
  {
    /** The entry's idempotency key, `run:<run id>:<mode>`, so copying again adds nothing. */
    sourceKey: text("source_key").primaryKey(),
    /** The deleted run's id, when known; nothing references it. */
    runId: uuid("run_id"),
    /** The run's teammate, as it was; it may be deleted too, so nothing references it. */
    teammateId: uuid("teammate_id"),
    accessMode: text("access_mode").$type<AuthMode>().notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    /** When the entry was written, as the run finished. */
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("legacy_deleted_run_usage_at_idx").on(table.at),
    check("legacy_deleted_run_usage_access_mode_check", oneOf(table.accessMode, AUTH_MODES)),
  ],
);
