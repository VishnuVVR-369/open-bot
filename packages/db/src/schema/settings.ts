// Usage, stored credentials and the owner's settings.
import { type AuthMode, type ChatgptAuthSource } from "@open-bot/domain";
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns";
import { runs } from "./runs";
import { bots } from "./teammates";

export const usageEntries = pgTable(
  "usage_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    authMode: text("auth_mode").$type<AuthMode>().notNull(),
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
    .$type<ChatgptAuthSource>()
    .notNull()
    .default("host"),
  /** What every teammate knows about you: Markdown you write, and facts teammates add. */
  aboutMe: text("about_me").notNull().default(""),
  aboutMeUpdatedAt: timestamp("about_me_updated_at", { withTimezone: true }),
  /** Set when Codex reported the ChatGPT plan's usage limit; runs use the API key until then. */
  planLimitedUntil: timestamp("plan_limited_until", { withTimezone: true }),
  updatedAt: updatedAt(),
});
