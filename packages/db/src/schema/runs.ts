// Runs: queued teammate work, its timeline events and the files it made.
import {
  type AuthMode,
  type RunEventPayload,
  type RunRating,
  type RunStatus,
  type RunTrigger,
  type RunWait,
} from "@open-bot/domain";
import {
  bigserial,
  boolean,
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
import { bytea, createdAt } from "./columns";
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
  },
  (table) => [
    index("runs_chat_idx").on(table.chatId, table.createdAt),
    index("runs_status_idx").on(table.status),
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
