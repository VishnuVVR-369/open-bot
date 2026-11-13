import type { ChatEntry } from "@open-bot/api";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";

/** Load a linked reply's history before scrolling to it, only while this chat is focused. */
export function useChatRunTarget({
  chatId,
  runId,
  items,
  oldest,
  hasMore,
  loading,
  loadOlder,
  scrollToIndex,
}: {
  chatId: string;
  runId: string | undefined;
  /** Visible rows, newest first, just as the inverted list renders them. */
  items: ChatEntry[];
  /** The oldest loaded entry, including messages hidden inside a steered turn. */
  oldest: string | undefined;
  hasMore: boolean;
  loading: boolean;
  loadOlder: () => Promise<void>;
  scrollToIndex: (index: number) => void;
}) {
  const jumped = useRef<string | null>(null);
  const attemptedPage = useRef<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!runId || loading) return;
      const target = JSON.stringify([chatId, runId]);
      if (jumped.current === target) return;
      const index = items.findIndex((entry) => entry.type === "run" && entry.run.id === runId);
      if (index >= 0) {
        jumped.current = target;
        scrollToIndex(index);
      } else if (hasMore && oldest) {
        const page = JSON.stringify([target, oldest]);
        // A failed page waits for an explicit retry instead of looping on the network error.
        if (attemptedPage.current === page) return;
        attemptedPage.current = page;
        void loadOlder();
      }
    }, [chatId, runId, items, oldest, hasMore, loading, loadOlder, scrollToIndex]),
  );
}
