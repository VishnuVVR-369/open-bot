// The Telegram link and the messages sent through it.
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { approvals } from "./approvals";
import { chats, messages } from "./chats";
import { createdAt, updatedAt } from "./columns";

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
