// Chats, their members and messages, each teammate's Codex thread in a chat, and uploads.
import {
  type AuthMode,
  type ChatKind,
  type MessageRole,
  type UploadStatus,
} from "@open-bot/domain";
import {
  bigint,
  check,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, updatedAt } from "./columns";
import { bots } from "./teammates";

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<ChatKind>().notNull(),
    title: text("title").notNull(),
    /**
     * Whether the title says what the chat is about: you named it, or its teammate did with
     * set_chat_title. A direct chat starts out named after its teammate, untitled.
     */
    titled: boolean("titled").notNull().default(false),
    /** The bot of a direct or scheduled chat. */
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    /**
     * The teammate's main chat: the direct chat where work that isn't started from a chat arrives,
     * such as tasks and questions from teammates. At most one per teammate. Archiving it hands the
     * role to another direct chat; `mainChat()` in the worker also repairs a main chat archived by
     * an older worker.
     */
    main: boolean("main").notNull().default(false),
    createdAt: createdAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    /** When you last looked at the chat, on any device. Replies after this are unread. */
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("chats_bot_idx").on(table.botId),
    index("chats_activity_idx").on(table.lastActivityAt),
    uniqueIndex("chats_main_unique")
      .on(table.botId) // vocabulary: allow
      .where(sql`${table.main}`),
    check("chats_main_direct", sql`not ${table.main} or ${table.kind} = 'direct'`),
  ],
);

export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.botId] })],
);

/** One Codex thread per bot per chat. */
export const botThreads = pgTable(
  "bot_threads",
  {
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    codexThreadId: text("codex_thread_id").notNull(),
    memoryGeneration: text("memory_generation").notNull().default(""),
    /** Threads keep the tools they started with, so a new tool set starts a new thread. */
    toolsVersion: integer("tools_version").notNull(),
    /** Whether the thread talks to the model through the ChatGPT plan or the API key. */
    authMode: text("auth_mode").$type<AuthMode>().notNull().default("plan"),
    /**
     * The connections and AGENTS.md the thread was given. Codex keeps both for a thread's life, so
     * a change forks the conversation into a thread that has the new ones.
     */
    configurationKey: text("configuration_key").notNull().default(""),
    /** When the thread last saw your profile: in AGENTS.md when it started, or in a message since. */
    profileSeenAt: timestamp("profile_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the thread last saw the bot's lessons, the same way. */
    lessonsSeenAt: timestamp("lessons_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.botId] })],
);

export interface Attachment {
  name: string;
  path: string;
  mime: string;
  size: number;
}

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").$type<MessageRole>().notNull(),
    text: text("text").notNull(),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
    /** Bots this message addressed with @mentions (group chats). */
    mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
    /** Where you sent it from. Replies to messages sent from Telegram go back there. */
    via: text("via").$type<"app" | "telegram">().notNull().default("app"),
    /** Set when the message joined a bot's running turn instead of starting a run. */
    steeredRunId: uuid("steered_run_id"),
    /** Set when the message is your feedback on a reply, asking the bot to do it again. */
    redoOfRunId: uuid("redo_of_run_id"),
    /** Original feedback request, for exact retry validation and durable lesson saving. */
    feedbackRequest: jsonb("feedback_request").$type<{ text: string; remember: boolean }>(),
    /** The sender's id for this message, so a retried send never saves it twice. */
    clientId: uuid("client_id"),
    /**
     * `pending` until every teammate it's for got it (a run or a steer). The worker dispatches
     * pending messages again, so a crash between saving and dispatching loses nothing.
     */
    dispatchStatus: text("dispatch_status")
      .$type<MessageDispatchStatus>()
      .notNull()
      .default("pending"),
    createdAt: createdAt(),
  },
  (table) => [
    index("messages_chat_idx").on(table.chatId, table.createdAt),
    // Upload cleanup asks which messages carry a file.
    index("messages_attachments_idx").using("gin", table.attachments.op("jsonb_path_ops")),
    uniqueIndex("messages_client_id_unique").on(table.clientId),
    index("messages_pending_dispatch_idx")
      .on(table.createdAt)
      .where(sql`${table.dispatchStatus} = 'pending'`),
  ],
);

export type MessageDispatchStatus = "pending" | "dispatched";

/**
 * Delivering one message to one teammate. The row is claimed before the delivery, so a message
 * dispatched twice still reaches each teammate once.
 */
export const messageDispatches = pgTable(
  "message_dispatches",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** A new run, or joining the teammate's running turn. */
    kind: text("kind").$type<"run" | "steer">().notNull(),
    /** A steer is `sending` while it's being delivered; a run is `done` as soon as it's queued. */
    status: text("status").$type<"sending" | "done" | "failed">().notNull(),
    runId: uuid("run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.botId] })],
);

/**
 * Files you attach to messages, written to the computer. The id comes from the sender and the
 * path from the id, so a retried upload writes the same file again instead of a second one, and
 * a message can only reference an upload that's `complete` (its size and SHA-256 checked).
 */
export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id").primaryKey(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    /** Hex SHA-256 of the file, as the sender computed it. */
    sha256: text("sha256").notNull(),
    status: text("status").$type<UploadStatus>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uploads_path_unique").on(table.path),
    index("uploads_status_idx").on(table.status, table.updatedAt),
  ],
);
