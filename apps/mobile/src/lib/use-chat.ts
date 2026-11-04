import {
  endsRun,
  type ChatData,
  type ChatEntry,
  type MessageView,
  type StreamRunEvent,
} from "@open-bot/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { applyHistoryEvent, mergeSnapshot, type ChatHistory } from "./chat-history";
import { queryKeys } from "./query";
import { useRealtime } from "./realtime";
import { useChatVisibility } from "./use-chat-visibility";

const BUFFER = 2_000;

/** A chat's loaded history, kept continuous across snapshots and live events. */
export function useChat(chatId: string) {
  const queryClient = useQueryClient();
  const { watchChat } = useRealtime();
  const query = useQuery({
    queryKey: queryKeys.chat(chatId),
    queryFn: () => api.chats.get({ chatId }),
  });
  const { refetch: refetchQuery } = query;
  const [live, setLive] = useState<ChatHistory | null>(null);
  const liveRef = useRef<ChatHistory | null>(null);
  const [loadedSnapshot, setLoadedSnapshot] = useState<{
    data: ChatData;
    updatedAt: number;
  } | null>(null);
  const [streamVersion, setStreamVersion] = useState<number | null>(null);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const updateLive = useCallback((next: ChatHistory | null) => {
    if (!next) setStreamVersion(null);
    else if (!liveRef.current || next.cursor < liveRef.current.cursor)
      setStreamVersion((version) => (version ?? 0) + 1);
    liveRef.current = next;
    setLive(next);
  }, []);
  const [sent, setSent] = useState<MessageView[]>([]);
  // Once we've paged back, that oldest page determines whether there's more history.
  const [hasOlder, setHasOlder] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const loadingRef = useRef(false);
  const generation = useRef(0);
  const buffer = useRef<StreamRunEvent[]>([]);
  const bufferedAfter = useRef(Infinity);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetchSoon = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    }, 150);
  }, [chatId, queryClient]);

  useEffect(() => {
    generation.current += 1;
    buffer.current = [];
    bufferedAfter.current = Infinity;
    updateLive(null);
    setLoadedSnapshot(null);
    setRefreshingHistory(false);
    setHistoryError(null);
    setSent([]);
    setHasOlder(null);
    setLoadingOlder(false);
    setOlderError(null);
    loadingRef.current = false;
    return () => {
      generation.current += 1;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = null;
    };
  }, [chatId, updateLive]);

  useEffect(() => {
    if (!query.data) return;
    const latest = query.data;
    const updatedAt = query.dataUpdatedAt;
    let cancelled = false;
    const boundary = liveRef.current?.entries.at(-1)?.at;
    const refresh = async () => {
      setHistoryError(null);
      let page = latest;
      const pages = [page];
      if (boundary && page.hasMore && page.entries[0] && page.entries[0].at > boundary) {
        setRefreshingHistory(true);
        while (page.hasMore && page.entries[0] && page.entries[0].at > boundary) {
          const before = page.entries[0].at;
          page = await api.chats.get({ chatId, before });
          if (cancelled) return;
          if (!page.entries.length || page.entries[0]!.at >= before)
            throw new Error("Couldn't load the intervening chat history. Try again.");
          pages.push(page);
        }
      }
      if (cancelled) return;
      let next = liveRef.current;
      for (const snapshot of pages)
        next = mergeSnapshot(next, snapshot, buffer.current, bufferedAfter.current);
      updateLive(next);
      setLoadedSnapshot({ data: latest, updatedAt });
    };
    void refresh()
      .catch((error: unknown) => {
        if (!cancelled) setHistoryError(error);
      })
      .finally(() => {
        if (!cancelled) setRefreshingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, query.data, query.dataUpdatedAt, updateLive]);

  useFocusEffect(
    useCallback(() => {
      if (streamVersion === null || !liveRef.current) return;
      let after = liveRef.current.cursor;
      if (after < bufferedAfter.current || after > (buffer.current.at(-1)?.id ?? -1)) {
        buffer.current = [];
        bufferedAfter.current = after;
      }
      return watchChat(chatId, after, (event) => {
        if (event.id > (buffer.current.at(-1)?.id ?? bufferedAfter.current))
          buffer.current.push(event);
        if (buffer.current.length > BUFFER) {
          const removed = buffer.current.splice(0, buffer.current.length - BUFFER);
          bufferedAfter.current = removed.at(-1)!.id;
        }
        const current = liveRef.current;
        if (!current) return;
        const { chat, unknownRun, applied } = applyHistoryEvent(current, event, after);
        after = Math.max(after, event.id);
        if (unknownRun || (applied && endsRun(event))) refetchSoon();
        updateLive(chat);
      });
    }, [chatId, streamVersion, watchChat, refetchSoon, updateLive]),
  );

  /** Show a message you just sent, before the next snapshot has it. */
  const addSent = useCallback(
    (message: MessageView) => {
      setSent((current) => [...current, message]);
      refetchSoon();
    },
    [refetchSoon],
  );

  const entries = useMemo(() => {
    if (!live) return [];
    const key = (entry: ChatEntry) =>
      entry.type === "message" ? `m:${entry.message.id}` : `r:${entry.run.id}`;
    const known = new Set(live.entries.map(key));
    const extra: ChatEntry[] = sent
      .filter((message) => !known.has(`m:${message.id}`))
      .map((message) => ({ type: "message", at: message.createdAt, message }));
    return [...live.entries, ...extra].sort((a, b) => a.at.localeCompare(b.at));
  }, [live, sent]);

  const finished = useMemo(
    () =>
      Object.values(live?.runs ?? {}).filter(
        (run) => run.timeline.status === "completed" || run.timeline.status === "failed",
      ).length,
    [live],
  );
  const refreshHistory = useCallback(async () => {
    await queryClient.cancelQueries({ queryKey: queryKeys.chat(chatId), exact: true });
    const result = await refetchQuery({ throwOnError: true });
    if (!result.isSuccess) throw result.error;
    return result.dataUpdatedAt;
  }, [chatId, queryClient, refetchQuery]);
  const refetch = useChatVisibility(
    chatId,
    finished,
    live !== null &&
      loadedSnapshot !== null &&
      loadedSnapshot.data === query.data &&
      !query.error &&
      !historyError
      ? loadedSnapshot.updatedAt
      : null,
    refreshHistory,
  );

  const hasMore = hasOlder ?? query.data?.hasMore ?? false;

  /** The page before the oldest one shown. */
  const loadOlder = useCallback(async () => {
    const oldest = entries[0]?.at;
    if (!hasMore || !oldest || loadingRef.current) return;
    const started = generation.current;
    loadingRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.chats.get({ chatId, before: oldest });
      if (started !== generation.current) return;
      updateLive(mergeSnapshot(liveRef.current, page, buffer.current, bufferedAfter.current));
      setHasOlder(page.hasMore && page.entries.length > 0);
    } catch (error) {
      if (started === generation.current) setOlderError(error);
    } finally {
      if (started === generation.current) {
        loadingRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [chatId, entries, hasMore, updateLive]);

  return {
    chat: query.data?.chat ?? null,
    members: query.data?.members ?? [],
    entries,
    runs: live?.runs ?? {},
    loading: query.isLoading || refreshingHistory,
    error: query.error ?? historyError,
    refetch,
    addSent,
    hasMore,
    loadingOlder,
    olderError,
    loadOlder,
  };
}
