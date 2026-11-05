import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export { compactNumber, formatDuration, plainText } from "@open-bot/shared";

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
 * For a reply's header controls: shown when you hover or focus the reply, and taking no room
 * otherwise, so what's always shown (like your rating) sits next to the name. Still reachable with
 * the keyboard, since focusing one reveals them all. Anything marked `data-pinned` in the reply,
 * like an open menu, keeps them shown so they don't shift under it.
 */
export const REVEAL_ON_RUN_HOVER =
  "max-w-0 overflow-hidden opacity-0 transition-opacity group-hover/run:max-w-none group-hover/run:opacity-100 group-focus-within/run:max-w-none group-focus-within/run:opacity-100 group-has-[[data-pinned]]/run:max-w-none group-has-[[data-pinned]]/run:opacity-100 pointer-coarse:max-w-none pointer-coarse:opacity-100";
