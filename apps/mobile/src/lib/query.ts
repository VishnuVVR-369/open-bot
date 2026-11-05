import { QueryCache, QueryClient } from "@tanstack/react-query";
import { isRetryable, isUnauthorized } from "./errors";

let onUnauthorized: () => void = () => {};

/** What to do when the session turns out to be gone (signed out elsewhere, or expired). */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) onUnauthorized();
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (failures, error) => isRetryable(error) && failures < 2,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  screens: ["screens"] as const,
  home: ["home"] as const,
  teammates: ["teammates"] as const,
  chats: ["chats"] as const,
  chatDetails: ["chat"] as const,
  chat: (chatId: string) => ["chat", chatId] as const,
  approvals: ["approvals"] as const,
  approvalDetails: ["approval"] as const,
  approval: (approvalId: string) => ["approval", approvalId] as const,
  approvalRules: ["approval-rules"] as const,
  notifications: ["notifications"] as const,
  search: (query: string) => ["search", query] as const,
  file: (path: string) => ["file", path] as const,
  pages: ["pages"] as const,
  page: (pageId: string) => ["pages", pageId] as const,
  /** Short-lived, so never shared with the lists the "pages" event refreshes. */
  pageLink: (versionId: string, theme: string) => ["page-link", versionId, theme] as const,
};

/**
 * What an app-wide change from the stream (`app` events) or a push makes stale. Everything else
 * is refreshed when the stream (re)connects.
 */
export function keysForAppEvent(type: string): (readonly unknown[])[] {
  switch (type) {
    case "approvals":
      return [
        queryKeys.approvals,
        queryKeys.approvalDetails,
        queryKeys.approvalRules,
        queryKeys.chatDetails,
        queryKeys.home,
        queryKeys.teammates,
      ];
    case "notification":
      return [queryKeys.notifications, queryKeys.home];
    case "chats":
      return [queryKeys.chats, queryKeys.chatDetails, queryKeys.home, queryKeys.teammates];
    case "bots":
      return [queryKeys.teammates, queryKeys.chats, queryKeys.home, queryKeys.approvalRules];
    case "pages":
      return [queryKeys.pages];
    case "takeovers":
    case "screens":
    case "lease":
    case "computer":
      return [queryKeys.screens, queryKeys.home, queryKeys.teammates];
    default:
      return [queryKeys.home];
  }
}

/** What a push makes stale: what it's about, and the lists and badges that show it. */
export function keysForPush(data: {
  type: string;
  approvalId?: string;
  chatId?: string;
  pageId?: string;
}): (readonly unknown[])[] {
  const keys: (readonly unknown[])[] = [queryKeys.home];
  if (data.type === "notification") keys.push(queryKeys.notifications, queryKeys.screens);
  if (data.approvalId) keys.push(queryKeys.approvals, queryKeys.approval(data.approvalId));
  if (data.chatId) keys.push(queryKeys.chats, queryKeys.chat(data.chatId), queryKeys.teammates);
  if (data.pageId) keys.push(queryKeys.pages);
  return keys;
}
