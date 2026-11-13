// Pages teammates publish, and their versions.
import { type PageIssue } from "@open-bot/domain";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { chats } from "./chats";
import { bytea, createdAt, updatedAt } from "./columns";
import { runs } from "./runs";
import { bots } from "./teammates";

/**
 * A page a teammate built for you: self-contained HTML, published as versions that never change.
 * You open them in the apps through the pages service, never from the computer.
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The teammate who made it. Pages stay when a teammate is removed. */
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    /** The chat it was made in, where questions about it go. */
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    /** The latest version's title and summary. */
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    /** The file on the computer the latest version was published from. */
    sourcePath: text("source_path"),
    currentVersionId: uuid("current_version_id"),
    versionCount: integer("version_count").notNull().default(0),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pages_updated_idx").on(table.updatedAt),
    index("pages_source_idx").on(table.botId, table.sourcePath),
  ],
);

export const pageVersions = pgTable(
  "page_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    /** 1 for the first version, then 2, 3… */
    number: integer("number").notNull(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    /** What changed from the version before, in the teammate's words. */
    note: text("note").notNull().default(""),
    html: text("html").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    /** The text you'd read on the page, for search and for teammates to read back. */
    text: text("text").notNull().default(""),
    /** The top of the page at laptop width, in the light theme and in the dark one, for cards. */
    thumbnail: bytea("thumbnail"),
    thumbnailDark: bytea("thumbnail_dark"),
    /** Warnings from the check when it was published. */
    issues: jsonb("issues").$type<PageIssue[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("page_versions_number_unique").on(table.pageId, table.number)],
);
