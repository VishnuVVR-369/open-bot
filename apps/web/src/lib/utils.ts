import { clsx, type ClassValue } from "clsx";
import { differenceInCalendarDays, format, isSameYear } from "date-fns";
import { twMerge } from "tailwind-merge";

export { compactNumber, formatDuration, plainText } from "@open-bot/domain";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** A chat's address, scrolled to one run when it's given. */
export function chatHref(chatId: string, runId?: string | null): string {
  return runId ? `/chats/${chatId}#run-${runId}` : `/chats/${chatId}`;
}

/** Where a notification leads: the page a teammate published, else the chat it's about. */
export function notificationHref(notification: {
  chatId: string | null;
  runId: string | null;
  pageId: string | null;
}): string | null {
  if (notification.pageId) return `/pages/${notification.pageId}`;
  return notification.chatId ? chatHref(notification.chatId, notification.runId) : null;
}

/**
 * For a reply's actions (copy, read aloud, rate), in the row under the reply. They keep their place
 * and show when you hover or focus the reply, so the row never shifts; on the latest reply in a chat,
 * and on a touch screen, which can't hover, they always show. Still reachable with the keyboard,
 * since focusing one reveals them all. Anything marked `data-pinned` in the reply, like an open
 * menu, keeps them shown.
 */
export const REVEAL_ON_RUN_HOVER =
  "opacity-0 transition-opacity group-hover/run:opacity-100 group-focus-within/run:opacity-100 group-has-[[data-pinned]]/run:opacity-100 group-data-[latest]/run:opacity-100 pointer-coarse:opacity-100";

/**
 * When a run started, with its day unless that is today. A main chat collects days of routines,
 * and a bare "7:30 AM" there doesn't say which morning.
 */
export function runClock(at: Date, now: Date = new Date()): string {
  const time = format(at, "h:mm a");
  const days = differenceInCalendarDays(now, at);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${format(at, "EEE")} ${time}`;
  return `${format(at, isSameYear(at, now) ? "MMM d" : "MMM d, yyyy")}, ${time}`;
}
