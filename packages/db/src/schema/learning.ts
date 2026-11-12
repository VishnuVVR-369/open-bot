// What teammates learn: skills, lessons and proposed instruction changes.
import { type Creator } from "@open-bot/domain";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, updatedAt } from "./columns";
import { runs } from "./runs";
import { bots } from "./teammates";

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
    createdBy: text("created_by").$type<Creator>().notNull(),
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
