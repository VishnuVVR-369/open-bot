// Approvals and the owner's standing approval rules.
import { type ApprovalKind, type ApprovalStatus, type RuleKind } from "@open-bot/domain";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chats } from "./chats";
import { createdAt } from "./columns";
import { runs } from "./runs";
import { bots } from "./teammates";

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
