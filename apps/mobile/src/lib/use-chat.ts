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

/** Keep loaded history when the latest page moves forward, with fresh views winning overlaps. */
function mergeHistory(previous: LiveChat | null, latest: LiveChat): LiveChat {
  const key = (entry: ChatEntry) =>
    entry.type === "message" ? `m:${entry.message.id}` : `r:${entry.run.id}`;
  const entries = new Map((previous?.entries ?? []).map((entry) => [key(entry), entry]));
  for (const entry of latest.entries) entries.set(key(entry), entry);
  return {
    ...latest,
    entries: [...entries.values()].sort((a, b) => a.at.localeCompare(b.at)),
    runs: { ...previous?.runs, ...latest.runs },
  };
}

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
  // Once we've paged back, that oldest page determines whether there's more history.
  const [hasOlder, setHasOlder] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const loadingRef = useRef(false);
  const generation = useRef(0);
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
    generation.current += 1;
    buffer.current = [];
    setLive(null);
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
  }, [chatId]);

  // Rebuild from each snapshot, with the events that arrived since it was taken.
  useEffect(() => {
    if (!query.data) return;
    const { chat, unknownRun } = liveChatFromSnapshot(query.data, buffer.current);
    setLive((current) => mergeHistory(current, chat));
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
    return [...live.entries, ...extra].sort((a, b) => a.at.localeCompare(b.at));
  }, [live, sent]);

  const finished = useMemo(
    () =>
      Object.values(live?.runs ?? {}).filter(
        (run) => run.timeline.status === "completed" || run.timeline.status === "failed",
      ).length,
    [live],
  );
  useChatVisibility(chatId, finished);

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
      const { chat } = liveChatFromSnapshot(page, buffer.current);
      // A page requested before a newer snapshot mustn't roll its state or stream cursor back.
      setLive((current) => (current ? mergeHistory(chat, current) : chat));
      setHasOlder(page.hasMore && page.entries.length > 0);
    } catch (error) {
      if (started === generation.current) setOlderError(error);
    } finally {
      if (started === generation.current) {
        loadingRef.current = false;
        setLoadingOlder(false);
      }
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
    olderError,
    loadOlder,
  };
}
