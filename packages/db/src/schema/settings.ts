// Stored credentials and the owner's settings.
import { type ChatgptAuthSource } from "@open-bot/domain";
import { bigint, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns";

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
  /**
   * How many days model logs keep their bodies (inputs, responses, tool arguments, Codex message
   * payloads); null keeps them forever. Numbers, statuses, tool names and links never expire.
   */
  modelLogRetentionDays: integer("model_log_retention_days"),
  updatedAt: updatedAt(),
});
