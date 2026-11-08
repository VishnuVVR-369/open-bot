import { z } from "zod";

/**
 * Something app-wide changed, as the web app and the worker announce it on the `app` NOTIFY
 * channel and the stream passes it on to open tabs and phones. Each type names what changed, not
 * which screen shows it; what each one refreshes is `APP_EVENT_REFRESHES` in `@open-bot/api`.
 */
export const APP_EVENT_TYPES = [
  "memory",
  "lease",
  "computer",
  "approvals",
  "takeovers",
  "bots",
  "chats",
  "schedules",
  "triggers",
  "profile",
  "lessons",
  "tasks",
  "telegram",
  "skills",
  "vault",
  "connections",
  "email",
  "purchases",
  "pages",
  "auth",
] as const;

/** An app event that carries nothing but its type. */
export type PlainAppEventType = (typeof APP_EVENT_TYPES)[number];

export const appEventSchema = z.discriminatedUnion("type", [
  /** Notifications changed: a new one (with its id, so open tabs can show it) or read ones. */
  z.object({ type: z.literal("notification"), id: z.string().optional() }),
  ...APP_EVENT_TYPES.map((type) => z.object({ type: z.literal(type) })),
]);

export type AppEvent = { type: "notification"; id?: string } | { type: PlainAppEventType };
export type AppEventType = AppEvent["type"];

/** An event from the stream, or null for one this version doesn't know (from a newer server). */
export function parseAppEvent(value: unknown): AppEvent | null {
  const parsed = appEventSchema.safeParse(value);
  return parsed.success ? (parsed.data as AppEvent) : null;
}
