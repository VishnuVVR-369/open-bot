import {
  applyLiveEvent,
  endsRun,
  liveChatFromSnapshot,
  type ChatEntry,
  type LiveChat,
  type MessageView,
  type StreamRunEvent,
} from "@open-bot/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { queryKeys } from "./query";
import { useRealtime } from "./realtime";
import { useChatVisibility } from "./use-chat-visibility";

const BUFFER = 2_000;

/** A chat's messages and runs, kept live with the stream (the same logic as the web's). */
export function useChat(chatId: string) {
  const queryClient = useQueryClient();
  const { watchChat } = useRealtime();
  const query = useQuery({
    queryKey: queryKeys.chat(chatId),
    queryFn: () => api.chats.get({ chatId }),
  });
  const [live, setLive] = useState<LiveChat | null>(null);
  const [sent, setSent] = useState<MessageView[]>([]);
  // Pages before the latest one, oldest first, as you scroll back.
  const [older, setOlder] = useState<{ entries: ChatEntry[]; hasMore: boolean } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);
  const buffer = useRef<StreamRunEvent[]>([]);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetchSoon = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    }, 150);
  }, [chatId, queryClient]);

  useEffect(() => {
    buffer.current = [];
    setLive(null);
    setSent([]);
    setOlder(null);
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [chatId]);

  // Rebuild from each snapshot, with the events that arrived since it was taken.
  useEffect(() => {
    if (!query.data) return;
    const { chat, unknownRun } = liveChatFromSnapshot(query.data, buffer.current);
    setLive(chat);
    if (unknownRun) refetchSoon();
  }, [query.data, refetchSoon]);

  const cursor = query.data?.cursor;
  useFocusEffect(
    useCallback(() => {
      if (cursor === undefined) return;
      return watchChat(chatId, cursor, (event) => {
        buffer.current.push(event);
        if (buffer.current.length > BUFFER)
          buffer.current.splice(0, buffer.current.length - BUFFER);
        setLive((current) => {
          if (!current) return current;
          const { chat, unknownRun } = applyLiveEvent(current, event);
          if (unknownRun || endsRun(event)) refetchSoon();
          return chat;
        });
      });
    }, [chatId, cursor, watchChat, refetchSoon]),
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
    const earlier = (older?.entries ?? []).filter((entry) => !known.has(key(entry)));
    return [...earlier, ...live.entries, ...extra].sort((a, b) => a.at.localeCompare(b.at));
  }, [live, sent, older]);

  const finished = useMemo(
    () =>
      Object.values(live?.runs ?? {}).filter(
        (run) => run.timeline.status === "completed" || run.timeline.status === "failed",
      ).length,
    [live],
  );
  useChatVisibility(chatId, finished);

  const hasMore = older ? older.hasMore : (query.data?.hasMore ?? false);

  /** The page before the oldest one shown. */
  const loadOlder = useCallback(async () => {
    const oldest = entries[0]?.at;
    if (!hasMore || !oldest || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await api.chats.get({ chatId, before: oldest });
      setOlder((current) => ({
        entries: [...page.entries, ...(current?.entries ?? [])],
        hasMore: page.hasMore,
      }));
    } catch {
      // Scrolling back up tries again.
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [chatId, entries, hasMore]);

  return {
    chat: query.data?.chat ?? null,
    members: query.data?.members ?? [],
    entries,
    runs: live?.runs ?? {},
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    addSent,
    hasMore,
    loadingOlder,
    loadOlder,
  };
}
