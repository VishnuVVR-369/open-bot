// Notifications, and the phones and browsers they are pushed to.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chats } from "./chats";
import { createdAt } from "./columns";
import { pages } from "./pages";
import { runs } from "./runs";
import { teammates } from "./teammates";

export type NotificationKind =
  | "run_finished"
  | "run_failed"
  | "approval"
  | "takeover_request"
  | "bot_message"
  | "cap_reached"
  /** Your phone was woken to carry the computer's traffic and didn't answer. */
  | "egress_unanswered";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<NotificationKind>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    teammateId: uuid("bot_id").references(() => teammates.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    /** A page the teammate published for this, which the notification opens. */
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "set null" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("notifications_created_idx").on(table.createdAt)],
);

/** Browsers and phones that get push notifications. */
/** Phones that get notifications through Firebase Cloud Messaging, by their FCM token. */
export const nativePushDevices = pgTable("native_push_devices", {
  token: text("token").primaryKey(),
  platform: text("platform").$type<"android">().notNull(),
  /** Which device, in words, like "Pixel 9". */
  device: text("device").notNull().default(""),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  /** Which device, in words, like "Chrome on macOS". */
  device: text("device").notNull().default(""),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  createdAt: createdAt(),
});
