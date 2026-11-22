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
  | "teammate_message"
  | "cap_reached"
  /** Your phone was woken to carry the computer's traffic and didn't answer. */
  | "egress_unanswered"
  /** A message from Telegram kept failing, so it was skipped to let the ones after it through. */
  | "telegram_skipped";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<NotificationKind>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    teammateId: uuid("teammate_id").references(() => teammates.id, { onDelete: "cascade" }),
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
  /**
   * The phone's sign-in its pushes are for: a random id the app makes when you sign in and forgets
   * when you sign out. Pushes carry it, so the phone drops any sent for a sign-in it has left.
   * Null for an app from before it had one.
   */
  registration: text("registration"),
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

/**
 * Runs whose progress notification phones may be showing (`run-progress` pushes). The row is
 * written (and its `shown_at` moved on) before each live push, and marked `ended_at` once the end
 * has been sent, so a run that is over with an unended row owes phones that end: the worker sends
 * it when it starts again, unless the phones' copy has timed out by then. An ended row stays for a
 * while so a save that lands late can't make the end owed again; then it is deleted.
 */
export const runProgressNotifications = pgTable("run_progress_notifications", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  /**
   * When the run's last live update was sent. Phones show it until it times out, so the end is
   * owed only for a while after (`END_OWED_FOR_MS` in the worker).
   */
  shownAt: timestamp("shown_at", { withTimezone: true }).notNull().defaultNow(),
  /** When the end was sent (or the run ended before any push went): no later save moves it on. */
  endedAt: timestamp("ended_at", { withTimezone: true }),
});
