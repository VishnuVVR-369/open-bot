"use client";

import { useEffect, useMemo } from "react";
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import type { RunView } from "@/lib/types";
import { completedRepliesKey } from "./read-marker";

/**
 * Seen here means read everywhere: the phone doesn't list this chat as unread anymore. Marks the
 * chat read once it has loaded, whenever a reply finishes, and when the tab comes back into view.
 */
export function useMarkRead(
  chatId: string,
  runs: Record<string, RunView>,
  loading: boolean,
  error: unknown,
) {
  const finished = useMemo(() => completedRepliesKey(runs), [runs]);
  useEffect(() => {
    if (loading || error) return;
    const mark = () => {
      if (document.visibilityState === "visible") void attempt(api.chats.markRead({ chatId }));
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [chatId, finished, loading, error]);
}
