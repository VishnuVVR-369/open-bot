import type {
  ApprovalKind,
  RuleKind,
  VaultKind,
  Autonomy,
  EgressModeSetting,
  RunEventPayload,
  RunStatus,
  TriggerKind,
} from "@open-bot/shared";
import {
  bigint,
  check,
  date,
  doublePrecision,
  bigserial,
  boolean,
  customType,
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

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/* ---------------------------------------------------------------- Auth (Better Auth) */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  aaguid: text("aaguid"),
});

/* ---------------------------------------------------------------- The computer */

export const computers = pgTable("computers", {
  id: text("id").primaryKey().default("default"),
  provider: text("provider").notNull().default("docker"),
  providerRef: text("provider_ref"),
  egressMode: text("egress_mode").$type<EgressModeSetting>().notNull().default("prefer"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ---------------------------------------------------------------- Bots and chats */

export const bots = pgTable(
  "bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    role: text("role").notNull(),
    instructions: text("instructions").notNull().default(""),
    color: text("color").notNull(),
    emoji: text("emoji").notNull().default(""),
    autonomy: text("autonomy").$type<Autonomy>().notNull().default("risky"),
    model: text("model").notNull().default("gpt-6.1-sol"),
    reasoningEffort: text("reasoning_effort").notNull().default("medium"),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** What it may spend from the vault's cards each month, in cents. Null: it can't pay. */
    monthlyBudgetCents: integer("monthly_budget_cents"),
    /** Purchases up to this go ahead without asking you; larger ones ask. */
    autoApproveCents: integer("auto_approve_cents").notNull().default(0),
    /** When a lesson was last added or removed, so chats already going hear about it. */
    lessonsChangedAt: timestamp("lessons_changed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("bots_slug_unique").on(table.slug)],
);

/**
 * Helper chats hold a swarm helper's work; they don't show in your chat lists. A bot's inbox chat
 * is where the emails it gets arrive.
 */
export type ChatKind = "direct" | "group" | "scheduled" | "helper" | "inbox";

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<ChatKind>().notNull(),
    title: text("title").notNull(),
    /** The bot of a direct or scheduled chat. */
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("chats_bot_idx").on(table.botId),
    index("chats_activity_idx").on(table.lastActivityAt),
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
    authMode: text("auth_mode").$type<"plan" | "api_key">().notNull().default("plan"),
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

export type MessageRole = "user" | "system";

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
    createdAt: createdAt(),
  },
  (table) => [index("messages_chat_idx").on(table.chatId, table.createdAt)],
);

export type RunTrigger =
  | "user"
  | "schedule"
  | "watch"
  | "webhook"
  | "hand_back"
  | "approval"
  | "handoff"
  /** Another teammate asked this bot something with ask_teammate. */
  | "question"
  /** The answer to a question this bot asked, coming back to it. */
  | "answer"
  /** A task from the board this bot was asked to work on. */
  | "task"
  | "takeover_ended"
  /** A helper working on one part of a swarm, on its own screen. */
  | "swarm"
  /** A swarm's merged results, coming back to the teammate that started it. */
  | "swarm_results"
  /** An email to the bot's address. */
  | "email";

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
    waitingFor: text("waiting_for").$type<"approval" | "takeover">(),
    error: text("error"),
    authMode: text("auth_mode").$type<"plan" | "api_key">(),
    codexThreadId: text("codex_thread_id"),
    codexTurnId: text("codex_turn_id"),
    finalText: text("final_text"),
    /** Your thumbs up or down on the reply. */
    rating: text("rating").$type<"up" | "down">(),
    /** Set when you press stop, so the worker interrupts the turn. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("runs_chat_idx").on(table.chatId, table.createdAt),
    index("runs_status_idx").on(table.status),
    index("runs_bot_idx").on(table.botId, table.createdAt),
    index("runs_trigger_idx").on(table.triggerId, table.createdAt),
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

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"screenshot" | "upload">().notNull(),
  mime: text("mime").notNull(),
  bytes: bytea("bytes").notNull(),
  createdAt: createdAt(),
});

/* ---------------------------------------------------------------- Approvals and takeovers */

export type { ApprovalKind };
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ApprovalKind>().notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    /** Timeline item that shows this approval, so a decision can update it. */
    itemId: text("item_id").notNull(),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [index("approvals_status_idx").on(table.status, table.createdAt)],
);

/**
 * "Always allow" rules a bot follows without asking you: actions in plain words, commands by prefix,
 * or every file change.
 */
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    kind: text("kind").$type<RuleKind>().notNull(),
    /** The action in plain words, or the start of a command. Empty for file changes. */
    pattern: text("pattern").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("approval_rules_unique").on(table.botId, table.kind, table.pattern)],
);

export type TakeoverStatus = "requested" | "active" | "ended" | "dismissed";
export type TakeoverEndReason = "handed_back" | "user_idle" | "user_disconnected";

export const desktopTakeovers = pgTable(
  "desktop_takeovers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The screen you take over: every bot has its own, so this is the bot's id. */
    screenId: uuid("screen_id").references(() => bots.id, { onDelete: "cascade" }),
    status: text("status").$type<TakeoverStatus>().notNull(),
    /** A bot asked for this takeover with `request_takeover`. */
    requestedByRunId: uuid("requested_by_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    requestedByBotId: uuid("requested_by_bot_id").references(() => bots.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    /** Timeline item that shows the request. */
    itemId: text("item_id"),
    /** The run that held the desktop when you took it. */
    interruptedRunId: uuid("interrupted_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    endReason: text("end_reason").$type<TakeoverEndReason>(),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [index("takeovers_status_idx").on(table.status, table.screenId)],
);

/* ---------------------------------------------------------------- Skills */

/**
 * Saved, reusable instructions, invoked with `/name` in a chat or picked by a bot when they fit.
 * Written to the computer as Codex skills (SKILL.md), shared or for one teammate.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    instructions: text("instructions").notNull(),
    /** The teammate who can use it; null means every teammate. */
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    createdBy: text("created_by").$type<"user" | "bot">().notNull(),
    /** The bot that wrote it, when a bot saved it. */
    createdByBotId: uuid("created_by_bot_id").references(() => bots.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // A name is unique among the skills one teammate can use: the shared ones and its own.
    // The service also keeps a teammate's own skills from reusing a shared skill's name.
    uniqueIndex("skills_shared_name_unique")
      .on(table.name)
      .where(sql`${table.botId} is null`),
    uniqueIndex("skills_bot_name_unique")
      .on(table.botId, table.name)
      .where(sql`${table.botId} is not null`),
  ],
);

/* ---------------------------------------------------------------- Schedules and notifications */

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    kind: text("kind").$type<"cron" | "once">().notNull(),
    cron: text("cron"),
    runAt: timestamp("run_at", { withTimezone: true }),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Only tell you when there's news: a run with nothing to report doesn't notify you. */
    quiet: boolean("quiet").notNull().default(false),
    createdBy: text("created_by").$type<"user" | "bot">().notNull(),
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
 * webhook URL. Each firing runs in the bot's Scheduled chat with the trigger's prompt.
 */
export const triggers = pgTable(
  "triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TriggerKind>().notNull(),
    title: text("title").notNull(),
    /** What the bot is asked to do when it fires. */
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
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdBy: text("created_by").$type<"user" | "bot">().notNull(),
    createdByRunId: uuid("created_by_run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("triggers_token_unique").on(table.token),
    index("triggers_due_idx").on(table.enabled, table.nextCheckAt),
  ],
);

export type NotificationKind =
  "run_finished" | "run_failed" | "approval" | "takeover_request" | "bot_message" | "cap_reached";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<NotificationKind>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("notifications_created_idx").on(table.createdAt)],
);

/* ---------------------------------------------------------------- Usage, credentials and settings */

export const usageEntries = pgTable(
  "usage_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    authMode: text("auth_mode").$type<"plan" | "api_key">().notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    /** Cost in millionths of a dollar. Zero on the ChatGPT plan. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("usage_idempotency_unique").on(table.idempotencyKey),
    index("usage_created_idx").on(table.createdAt),
  ],
);

export const credentials = pgTable("credentials", {
  kind: text("kind")
    .$type<"openai_api_key" | "telegram_bot_token" | "vapid_keys" | "postmark_token">()
    .primaryKey(),
  /** AES-256-GCM ciphertext: iv.tag.data, base64url. */
  encrypted: text("encrypted").notNull(),
  hint: text("hint").notNull(),
  createdAt: createdAt(),
});

export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  monthlyCapMicros: bigint("monthly_cap_micros", { mode: "number" }).notNull().default(20_000_000),
  timezone: text("timezone").notNull().default("UTC"),
  /** How Codex signs in to ChatGPT: a device-code login stored in the computer, or this Mac's Codex login (development). */
  chatgptAuthSource: text("chatgpt_auth_source")
    .$type<"device" | "host">()
    .notNull()
    .default("host"),
  /** What every teammate knows about you: Markdown you write, and facts teammates add. */
  aboutMe: text("about_me").notNull().default(""),
  aboutMeUpdatedAt: timestamp("about_me_updated_at", { withTimezone: true }),
  /** Set when Codex reported the ChatGPT plan's usage limit; runs use the API key until then. */
  planLimitedUntil: timestamp("plan_limited_until", { withTimezone: true }),
  updatedAt: updatedAt(),
});

/* ---------------------------------------------------------------- Telegram */

/**
 * Your Telegram bot (its token is in `credentials`) and the one Telegram chat linked to it.
 * Single row: id = 1.
 */
export const telegram = pgTable("telegram", {
  id: integer("id").primaryKey().default(1),
  botUsername: text("bot_username"),
  /** The linked chat, once you send the bot its link code. Messages from anyone else are ignored. */
  chatId: text("chat_id"),
  /** Your name on Telegram, to show which account is linked. */
  linkedName: text("linked_name"),
  linkCode: text("link_code"),
  linkCodeExpiresAt: timestamp("link_code_expires_at", { withTimezone: true }),
  /** The next update to fetch, so a restart neither misses nor repeats a message. */
  updateOffset: bigint("update_offset", { mode: "number" }).notNull().default(0),
  /** The open-bot chat your last Telegram message went to; the next one goes there too. */
  lastChatId: uuid("last_chat_id").references(() => chats.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

/** Messages sent to and from Telegram, so a reply there finds its chat and approval. */
export const telegramMessages = pgTable(
  "telegram_messages",
  {
    telegramChatId: text("telegram_chat_id").notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "cascade" }),
    /** Your message, when it came from Telegram. */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.telegramChatId, table.telegramMessageId] }),
    index("telegram_messages_message_idx").on(table.messageId),
    index("telegram_messages_approval_idx").on(table.approvalId),
  ],
);

/** What a teammate learned from your feedback on its replies. It reads them before every task. */
export const lessons = pgTable(
  "lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** The reply the feedback was about. */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("lessons_bot_idx").on(table.botId, table.createdAt),
    index("lessons_run_idx").on(table.runId),
  ],
);

export type TaskStatus = "todo" | "doing" | "done";

/** The team's task board: work you or a teammate wrote down, who owns it, and how far it got. */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status").$type<TaskStatus>().notNull().default("todo"),
    /** The teammate doing it; null when nobody has it yet, or it's yours. */
    ownerBotId: uuid("owner_bot_id").references(() => bots.id, { onDelete: "set null" }),
    /** The day it's due, like 2026-10-20. */
    dueOn: date("due_on", { mode: "string" }),
    /** Order within its column. */
    position: doublePrecision("position").notNull().default(0),
    createdBy: text("created_by").$type<"user" | "bot">().notNull(),
    createdByBotId: uuid("created_by_bot_id").references(() => bots.id, { onDelete: "set null" }),
    /** The chat where the owner was last asked to work on it. */
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("tasks_status_idx").on(table.status, table.position),
    index("tasks_owner_idx").on(table.ownerBotId),
  ],
);

/** A teammate's suggested rewrite of its own instructions, waiting for you to accept it. */
export const instructionProposals = pgTable(
  "instruction_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** The instructions when it was suggested, to show what changes. */
    current: text("current").notNull(),
    proposed: text("proposed").notNull(),
    reason: text("reason").notNull(),
    status: text("status")
      .$type<"pending" | "accepted" | "dismissed">()
      .notNull()
      .default("pending"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("instruction_proposals_bot_idx").on(table.botId, table.status)],
);

/** Browsers and phones that get push notifications. */
export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  /** Which device, in words, like "Chrome on macOS". */
  device: text("device").notNull().default(""),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Logins and payment cards teammates fill in on the computer without reading them. The secret is
 * encrypted, and only the worker decrypts it, to type it on a teammate's screen.
 */
export const vaultItems = pgTable("vault_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<VaultKind>().notNull(),
  name: text("name").notNull(),
  /** The site a login belongs to, like github.com. It only fills in there. */
  domain: text("domain"),
  /** What you see without the secret: the username, or "Visa •••• 4242". */
  hint: text("hint").notNull(),
  /** AES-256-GCM ciphertext of the fields, as JSON. */
  encrypted: text("encrypted").notNull(),
  /** The teammates that may use it, or null for every teammate. */
  botIds: uuid("bot_ids").array(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PurchaseStatus = "pending" | "approved" | "denied" | "paid" | "not_paid";

/** What a teammate pays for with a vault card, which counts against its monthly budget. */
export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    cardId: uuid("card_id").references(() => vaultItems.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    amountCents: integer("amount_cents").notNull(),
    merchant: text("merchant").notNull(),
    description: text("description").notNull(),
    status: text("status").$type<PurchaseStatus>().notNull(),
    /** What the teammate said happened at checkout. */
    note: text("note"),
    /** Until when the teammate may fill the card for it. */
    fillableUntil: timestamp("fillable_until", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("purchases_bot_idx").on(table.botId, table.createdAt)],
);

export type SwarmStatus = "running" | "done" | "stopped";
export type SwarmTaskStatus = "queued" | "running" | "completed" | "failed" | "stopped";

/**
 * A big job a teammate split into parts, each worked on at the same time by a helper with its own
 * screen. When every part is done, the results come back to the teammate as one message.
 */
export const swarms = pgTable(
  "swarms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    /** Where the teammate started it, and gets the results. */
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** The timeline item in that run that shows its progress. */
    itemId: text("item_id").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<SwarmStatus>().notNull().default("running"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("swarms_bot_idx").on(table.botId, table.createdAt)],
);

/** One helper's part of a swarm. Its id is also the id of the screen it works on. */
export const swarmTasks = pgTable(
  "swarm_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    swarmId: uuid("swarm_id")
      .notNull()
      .references(() => swarms.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    /** The helper's chat, where its work shows. */
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    status: text("status").$type<SwarmTaskStatus>().notNull().default("queued"),
    result: text("result"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("swarm_tasks_swarm_idx").on(table.swarmId, table.position)],
);

/**
 * Services teammates use through MCP, like GitHub, Notion or a company API: faster and more
 * reliable than driving their websites. Headers and environment variables are encrypted.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What you call it, like "GitHub". */
    label: text("label").notNull(),
    /** Its name for Codex: letters, digits, _ and -. Unique. */
    name: text("name").notNull(),
    transport: text("transport").$type<"http" | "stdio">().notNull(),
    /** For http: the MCP endpoint. */
    url: text("url"),
    /** For stdio: the command the computer runs, and its arguments. */
    command: text("command"),
    args: text("args")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** AES-256-GCM ciphertext of { headers, env } as JSON. */
    encrypted: text("encrypted"),
    /** The header and variable names, without their values, to show what's set. */
    secretNames: text("secret_names")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The teammates that may use it, or null for every teammate. */
    botIds: uuid("bot_ids").array(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("connections_name_unique").on(table.name)],
);

/**
 * Email for teammates: each gets an address on your domain. Postmark delivers what arrives to a
 * secret webhook, and sends what teammates write. Its server token is in `credentials`.
 * Single row: id = 1.
 */
export const emailSettings = pgTable("email_settings", {
  id: integer("id").primaryKey().default(1),
  /** Addresses are the teammate's handle at this domain, like iris@team.example.com. */
  domain: text("domain"),
  /** The secret in the inbound webhook's address. */
  inboundToken: text("inbound_token").notNull(),
  /** Postmark's API, or a compatible service. */
  apiBaseUrl: text("api_base_url").notNull().default("https://api.postmarkapp.com"),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

/** Emails teammates got and sent. */
export const emails = pgTable(
  "emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    direction: text("direction").$type<"in" | "out">().notNull(),
    /** For emails a teammate writes: waiting for you, sent, or not. */
    status: text("status")
      .$type<"received" | "pending" | "sent" | "denied" | "failed">()
      .notNull()
      .default("received"),
    /** The email it answers, for threading. */
    replyToId: uuid("reply_to_id"),
    approvalId: uuid("approval_id"),
    /** Where the teammate wrote it, to show what happened to it. */
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    itemId: text("item_id"),
    error: text("error"),
    /** The Message-ID header, to thread replies. */
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    from: text("from").notNull(),
    to: text("to").notNull(),
    subject: text("subject").notNull().default(""),
    text: text("text").notNull().default(""),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("emails_bot_idx").on(table.botId, table.createdAt)],
);

/* ---------------------------------------------------------------- Versioned memory */

export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("fact"),
    content: text("content").notNull(),
    key: text("key"),
    fingerprint: text("fingerprint").notNull(),
    revision: integer("revision").notNull().default(1),
    state: text("state").notNull().default("active"),
    pinned: boolean("pinned").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    source: jsonb("source").notNull().default({}),
    legacyKey: text("legacy_key").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("memory_items_scope_state").on(table.botId, table.state),
    index("memory_items_search").using(
      "gin",
      sql`to_tsvector('english', ${table.content} || ' ' || regexp_replace(coalesce(${table.key}, ''),'[^[:alnum:]]+',' ','g'))`,
    ),
    uniqueIndex("memory_items_live_fingerprint")
      .on(sql`coalesce(${table.botId}::text, 'shared')`, table.fingerprint)
      .where(sql`${table.state} <> 'deleted'`),
    uniqueIndex("memory_items_live_topic")
      .on(sql`coalesce(${table.botId}::text, 'shared')`, table.key)
      .where(sql`${table.state} = 'active' and ${table.key} is not null`),
    check("memory_kind_check", sql`${table.kind} in ('fact','preference','lesson','note')`),
    check("memory_state_check", sql`${table.state} in ('active','candidate','deleted')`),
    check("memory_revision_positive", sql`${table.revision} > 0`),
    check("memory_deleted_empty", sql`${table.state} <> 'deleted' or ${table.content} = ''`),
  ],
);

export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memoryItems.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    content: text("content").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    source: jsonb("source").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("memory_revisions_version").on(table.memoryId, table.revision)],
);

export const memoryGenerations = pgTable("memory_generations", {
  scope: text("scope").primaryKey(),
  generation: integer("generation").notNull().default(1),
});

export const memoryJobs = pgTable(
  "memory_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    memoryId: uuid("memory_id").references(() => memoryItems.id, { onDelete: "cascade" }),
    revision: integer("revision"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("memory_jobs_pending")
      .on(table.availableAt)
      .where(sql`${table.completedAt} is null`),
    check("memory_job_kind_check", sql`${table.kind} in ('embed','extract')`),
  ],
);

/** Derived vectors are fenced by model and dimensions; they can be rebuilt independently. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as number[],
});
export const memoryEmbeddings = pgTable(
  "memory_embeddings",
  {
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memoryItems.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    model: text("model").notNull(),
    embedding: vector("embedding").notNull(),
  },
  (table) => [primaryKey({ columns: [table.memoryId, table.model] })],
);

export const memoryImports = pgTable("memory_imports", {
  key: text("key").primaryKey(),
  createdAt: createdAt(),
});

export const memoryUsage = pgTable("memory_usage", {
  day: date("day").primaryKey(),
  requests: integer("requests").notNull().default(0),
});

export const memoryContexts = pgTable("memory_contexts", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  botId: uuid("bot_id")
    .notNull()
    .references(() => bots.id, { onDelete: "cascade" }),
  generation: text("generation").notNull(),
  refs: jsonb("refs").notNull().default([]),
  createdAt: createdAt(),
});
