// Versioned memory and its background jobs.
import {
  MEMORY_JOB_KINDS,
  MEMORY_KINDS,
  MEMORY_STATES,
  type MemoryJobKind,
  type MemoryKind,
  type MemoryRef,
  type MemorySnapshot,
  type MemorySource,
  type MemoryState,
} from "@open-bot/domain";
import {
  check,
  date,
  bigserial,
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
import { createdAt, oneOf, updatedAt, vector } from "./columns";
import { runs } from "./runs";
import { teammates } from "./teammates";

export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teammateId: uuid("bot_id").references(() => teammates.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MemoryKind>().notNull().default("fact"),
    content: text("content").notNull(),
    key: text("key"),
    fingerprint: text("fingerprint").notNull(),
    revision: integer("revision").notNull().default(1),
    state: text("state").$type<MemoryState>().notNull().default("active"),
    pinned: boolean("pinned").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Who saved this revision. A forgotten memory keeps `{}`. */
    source: jsonb("source")
      .$type<MemorySource>()
      .notNull()
      .default({} as MemorySource),
    /** Unused since the one-time legacy import was removed; a later migration can drop it. */
    legacyKey: text("legacy_key").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("memory_items_scope_state").on(table.teammateId, table.state),
    index("memory_items_search").using(
      "gin",
      sql`to_tsvector('english', ${table.content} || ' ' || regexp_replace(coalesce(${table.key}, ''),'[^[:alnum:]]+',' ','g'))`,
    ),
    uniqueIndex("memory_items_live_fingerprint")
      .on(sql`coalesce(${table.teammateId}::text, 'shared')`, table.fingerprint)
      .where(sql`${table.state} <> 'deleted'`),
    uniqueIndex("memory_items_live_topic")
      .on(sql`coalesce(${table.teammateId}::text, 'shared')`, table.key)
      .where(sql`${table.state} = 'active' and ${table.key} is not null`),
    check("memory_kind_check", oneOf(table.kind, MEMORY_KINDS)),
    check("memory_state_check", oneOf(table.state, MEMORY_STATES)),
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
    snapshot: jsonb("snapshot").$type<MemorySnapshot>().notNull(),
    source: jsonb("source").$type<MemorySource>().notNull(),
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
    kind: text("kind").$type<MemoryJobKind>().notNull(),
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
    check("memory_job_kind_check", oneOf(table.kind, MEMORY_JOB_KINDS)),
  ],
);

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

/**
 * Markers that keep forgotten memory from being learned again: `forgotten:<scope>:<fingerprint>`
 * and `forget-source:<message id>`. Older rows also mark the removed one-time legacy imports.
 */
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
  teammateId: uuid("bot_id")
    .notNull()
    .references(() => teammates.id, { onDelete: "cascade" }),
  generation: text("generation").notNull(),
  refs: jsonb("refs").$type<MemoryRef[]>().notNull().default([]),
  createdAt: createdAt(),
});
