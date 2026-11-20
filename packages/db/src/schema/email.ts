// The teammates' email: settings and every email in or out.
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chats } from "./chats";
import { createdAt, updatedAt } from "./columns";
import { runs } from "./runs";
import { teammates } from "./teammates";

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
    teammateId: uuid("bot_id")
      .notNull()
      .references(() => teammates.id, { onDelete: "cascade" }),
    direction: text("direction").$type<"in" | "out">().notNull(),
    /**
     * For emails a teammate writes: waiting for you, being sent (claimed, so it goes once), sent,
     * or not.
     */
    status: text("status")
      .$type<"received" | "pending" | "sending" | "sent" | "denied" | "failed">()
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
  (table) => [index("emails_bot_idx").on(table.teammateId, table.createdAt)],
);
