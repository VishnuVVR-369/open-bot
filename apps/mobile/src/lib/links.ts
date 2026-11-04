import type { Href } from "expo-router";

/** The chat, opened at one reply when there is one. */
export const chatHref = (chatId: string, runId?: string | null): Href =>
  runId ? `/chats/${chatId}?run=${runId}` : `/chats/${chatId}`;

/** Where a notification goes in the app, like its push does. */
export function notificationHref(notification: {
  kind: string;
  botId?: string | null;
  chatId: string | null;
  runId: string | null;
}): Href {
  if (notification.kind === "takeover_request" && notification.botId)
    return `/screens/${encodeURIComponent(notification.botId)}`;
  if (notification.kind === "approval") return "/approvals";
  if (notification.chatId) return chatHref(notification.chatId, notification.runId);
  return "/";
}
