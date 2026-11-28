// Teammates.
import { type Autonomy } from "@open-bot/domain";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns";

export const teammates = pgTable(
  "teammates",
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
    isLead: boolean("is_lead").notNull().default(false),
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
  (table) => [uniqueIndex("teammates_slug_unique").on(table.slug)],
);

/**
 * A teammate made as a copy of another, under the id the app chose for it before asking, so the
 * same ask sent again after a lost answer finds this copy instead of making a second one.
 * `memoryCopiedAt` is when the original's memory came along: null with `copyMemory` means it
 * hasn't yet (it failed, or the first ask is still copying it), so a retry copies it again.
 */
export const teammateCopies = pgTable("teammate_copies", {
  teammateId: uuid("teammate_id")
    .primaryKey()
    .references(() => teammates.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => teammates.id, { onDelete: "cascade" }),
  copyMemory: boolean("copy_memory").notNull(),
  memoryCopiedAt: timestamp("memory_copied_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Helper chats hold a swarm helper's work; they don't show in your chat lists. A teammate's inbox chat
 * is where the emails it gets arrive.
 */
