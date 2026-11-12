// Tasks, and swarms of helpers working on them.
import {
  type Creator,
  type SwarmState,
  type SwarmTaskState,
  type TaskStatus,
} from "@open-bot/domain";
import {
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { chats } from "./chats";
import { createdAt, updatedAt } from "./columns";
import { runs } from "./runs";
import { bots } from "./teammates";

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
    createdBy: text("created_by").$type<Creator>().notNull(),
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
    status: text("status").$type<SwarmState>().notNull().default("running"),
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
    status: text("status").$type<SwarmTaskState>().notNull().default("queued"),
    result: text("result"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("swarm_tasks_swarm_idx").on(table.swarmId, table.position)],
);
