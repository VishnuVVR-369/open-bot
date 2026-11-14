// The computer, screen takeovers and screen operations.
import {
  type EgressMode,
  type LeaseReleaseReason,
  type PhoneMode,
  type ScreenOperationStatus,
} from "@open-bot/domain";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns";
import { runs } from "./runs";
import { bots } from "./teammates";

export const computers = pgTable("computers", {
  id: text("id").primaryKey().default("default"),
  provider: text("provider").notNull().default("docker"),
  providerRef: text("provider_ref"),
  egressMode: text("egress_mode").$type<EgressMode>().notNull().default("prefer"),
  /** When a paired phone carries the browser traffic. No effect until a phone is paired. */
  phoneEgress: text("phone_egress").$type<PhoneMode>().notNull().default("fallback"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type TakeoverStatus = "requested" | "active" | "ended" | "dismissed";

/** How a takeover ended: the reasons botd gives for releasing your hold on a screen. */
export type TakeoverEndReason = LeaseReleaseReason;

export const screenTakeovers = pgTable(
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
    /** The run that held the screen when you took it. */
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

/** A cancellation can exist before its screen/request is known. Never stores the code. */
export const screenOperations = pgTable(
  "screen_operations",
  {
    id: uuid("id").primaryKey(),
    takeoverId: uuid("takeover_id").references(() => screenTakeovers.id, { onDelete: "set null" }),
    screenId: uuid("screen_id").references(() => bots.id, { onDelete: "set null" }),
    status: text("status").$type<ScreenOperationStatus>().notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("screen_operations_status_idx").on(table.status)],
);

/** Durable delivery of a returned screen, even if the worker stopped after releasing it. */
export const takeoverDeliveries = pgTable("takeover_deliveries", {
  id: uuid("id")
    .primaryKey()
    .references(() => screenTakeovers.id, { onDelete: "cascade" }),
  continuationRunId: uuid("continuation_run_id").notNull().defaultRandom(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: createdAt(),
});
