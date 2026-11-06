/**
 * The pure parts of Gmail and Calendar triggers: which mail is new, which events are due, and the
 * keys that keep anything from waking a teammate twice.
 */
import type { CalendarEventFilter } from "@open-bot/shared";

/** One entry of Gmail's history.list, as much of it as triggers read. */
export interface HistoryRecord {
  id: string;
  messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
}

/** Mail that isn't news to wake for: what you sent, drafts, chats, spam and trash. */
const SKIPPED_LABELS = new Set(["SENT", "DRAFT", "CHAT", "SPAM", "TRASH"]);

/** Compares two Gmail history ids, which are 64-bit numbers as strings. */
export function compareHistoryIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The older of two history ids, so one history.list serves triggers that are at different points. */
export function oldestHistoryId(ids: string[]): string | null {
  return ids.reduce<string | null>(
    (oldest, id) => (oldest === null || compareHistoryIds(id, oldest) < 0 ? id : oldest),
    null,
  );
}

/** Messages that arrived after `after`, once each, in the order Gmail added them. */
export function addedMessages(
  history: HistoryRecord[],
  after: string | null,
): { id: string; threadId: string }[] {
  const seen = new Set<string>();
  const added: { id: string; threadId: string }[] = [];
  for (const record of history) {
    if (after !== null && compareHistoryIds(record.id, after) <= 0) continue;
    for (const { message } of record.messagesAdded ?? []) {
      if (seen.has(message.id)) continue;
      if (message.labelIds?.some((label) => SKIPPED_LABELS.has(label))) continue;
      seen.add(message.id);
      added.push({ id: message.id, threadId: message.threadId });
    }
  }
  return added;
}

/**
 * The Gmail search that finds a trigger's mail among recent messages. Its own search goes in
 * parentheses, so an `OR` in it can't undo the rest.
 */
export function gmailMatchQuery(query: string | null | undefined, days: number): string {
  const own = query?.trim();
  return [own ? `(${own})` : null, "-in:sent", "-in:drafts", "-in:chats", `newer_than:${days}d`]
    .filter(Boolean)
    .join(" ");
}

/** The key that keeps a message from waking a trigger twice. */
export function messageKey(id: string): string {
  return `mail:${id}`;
}

/** As much of a Calendar event as triggers read. */
export interface WatchedEvent {
  id: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  attendees?: { email: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
}

/** Events looked at each time: from now until the lead time plus one more check. */
export function calendarWindow(
  now: Date,
  leadMinutes: number,
  pollMinutes: number,
): { timeMin: string; timeMax: string } {
  return {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + (leadMinutes + pollMinutes * 2) * 60_000).toISOString(),
  };
}

/** Whether an event has someone besides you on it (rooms don't count). */
export function hasOtherGuests(event: WatchedEvent): boolean {
  return (event.attendees ?? []).some((guest) => !guest.self && !guest.resource);
}

/**
 * The key for one occurrence at one time. A recurring event's occurrences have their own ids, and
 * an event that moves gets a new key, so it wakes the teammate again for its new time.
 */
export function occurrenceKey(event: WatchedEvent): string | null {
  const start = event.start?.dateTime;
  if (!start) return null;
  return `event:${event.id}@${new Date(start).toISOString()}`;
}

/** An event started this long ago still counts, for a check that ran late. */
const LATE_GRACE_MS = 10 * 60_000;

/**
 * The occurrences due now: their lead time has come (give or take half a check), they haven't
 * long started, and they're ones the trigger is about. All-day events have no time to be early
 * for, cancelled ones aren't happening, and ones you declined aren't yours to prepare for.
 */
export function dueOccurrences(
  events: WatchedEvent[],
  options: { now: Date; leadMinutes: number; pollMinutes: number; filter: CalendarEventFilter },
): { event: WatchedEvent; key: string; startsAt: Date }[] {
  const now = options.now.getTime();
  const due: { event: WatchedEvent; key: string; startsAt: Date }[] = [];
  for (const event of events) {
    if (event.status === "cancelled") continue;
    const key = occurrenceKey(event);
    if (!key) continue;
    if (event.attendees?.some((guest) => guest.self && guest.responseStatus === "declined"))
      continue;
    if (options.filter === "guests" && !hasOtherGuests(event)) continue;
    const startsAt = new Date(event.start!.dateTime!);
    const wakeAt = startsAt.getTime() - options.leadMinutes * 60_000;
    if (wakeAt > now + (options.pollMinutes * 60_000) / 2) continue;
    if (startsAt.getTime() < now - LATE_GRACE_MS) continue;
    due.push({ event, key, startsAt });
  }
  return due.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** How soon an event starts, as the teammate reads it. */
export function startsIn(startsAt: Date, now: Date): string {
  const minutes = Math.round((startsAt.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return minutes < -1 ? `started ${-minutes} minutes ago` : "is starting now";
  if (minutes < 60) return `starts in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 24) return `starts in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 2.4) / 10;
  return `starts in ${days} day${days === 1 ? "" : "s"}`;
}
