import { ALWAYS_REFRESHED, APP_EVENT_REFRESHES, type ProcedurePath } from "@open-bot/api";
import type { AppEventType } from "@open-bot/domain";
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

/** Procedure paths keep namespace refreshes aligned with the shared API event map. */
export const queryKeys = {
  screens: ["screens", "list"] as const,
  home: ["home", "get"] as const,
  teammates: ["teammates", "list"] as const,
  chats: ["chats", "list"] as const,
  chatDetails: ["chats", "get"] as const,
  chat: (chatId: string) => ["chats", "get", chatId] as const,
  approvals: ["approvals", "list"] as const,
  approvalDetails: ["approvals", "get"] as const,
  approval: (approvalId: string) => ["approvals", "get", approvalId] as const,
  approvalRules: ["approvals", "rules"] as const,
  notifications: ["notifications", "list"] as const,
  search: (query: string) => ["search", "messages", query] as const,
  file: (path: string) => ["file", path] as const,
  // A page push refreshes both the list and any open page.
  pages: ["pages", "list"] as const,
  pageDetails: ["pages", "get"] as const,
  page: (pageId: string) => ["pages", "get", pageId] as const,
  /** Short-lived, so never shared with the lists the "pages" event refreshes. */
  pageLink: (versionId: string, theme: string) => ["page-link", versionId, theme] as const,
};

/**
 * Mobile reads that also embed another procedure's data. These are dependencies between reads,
 * not another event map: new events pick up the shared API semantics automatically. Expand once
 * from the original paths, so refreshing a dependency doesn't recursively refresh unrelated reads.
 */
const readDependencies: readonly {
  source: Readonly<ProcedurePath>;
  refresh: readonly Readonly<ProcedurePath>[];
}[] = [
  { source: ["approvals"], refresh: [queryKeys.chatDetails, queryKeys.teammates] },
  { source: queryKeys.chats, refresh: [queryKeys.chatDetails] },
  { source: queryKeys.teammates, refresh: [queryKeys.approvalRules] },
  { source: queryKeys.screens, refresh: [queryKeys.teammates] },
];

/** What an app-wide stream change makes stale, including the shared snapshots. */
export function keysForAppEvent(type: string): (readonly unknown[])[] {
  // Retain the old screen-event alias for callers on an older stream.
  const event = type === "screens" ? "computer" : type;
  const paths = [
    ...ALWAYS_REFRESHED,
    ...(Object.hasOwn(APP_EVENT_REFRESHES, event)
      ? APP_EVENT_REFRESHES[event as AppEventType]
      : []),
  ];
  return [
    ...paths,
    ...readDependencies.flatMap(({ source, refresh }) =>
      paths.some((path) =>
        path
          .slice(0, Math.min(path.length, source.length))
          .every((part, index) => source[index] === part),
      )
        ? refresh
        : [],
    ),
  ];
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
  if (data.pageId) keys.push(queryKeys.pages, queryKeys.pageDetails);
  return keys;
}
