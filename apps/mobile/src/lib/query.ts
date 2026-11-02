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
  teammates: ["teammates"] as const,
  chats: ["chats"] as const,
  chat: (chatId: string) => ["chat", chatId] as const,
  approvals: ["approvals"] as const,
  approval: (approvalId: string) => ["approval", approvalId] as const,
};
