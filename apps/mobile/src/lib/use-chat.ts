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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { queryKeys } from "./query";
import { useRealtime } from "./realtime";
import { useChatVisibility } from "./use-chat-visibility";

const BUFFER = 2_000;

/** A chat's messages and runs, kept live with the stream (the same logic as the web's). */
export function useChat(chatId: string) {
  useChatVisibility(chatId);
  const queryClient = useQueryClient();
  const { watchChat } = useRealtime();
  const query = useQuery({
    queryKey: queryKeys.chat(chatId),
    queryFn: () => api.chats.get({ chatId }),
  });
  const [live, setLive] = useState<LiveChat | null>(null);
  const [sent, setSent] = useState<MessageView[]>([]);
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
  useEffect(() => {
    if (cursor === undefined) return;
    return watchChat(chatId, cursor, (event) => {
      buffer.current.push(event);
      if (buffer.current.length > BUFFER) buffer.current.splice(0, buffer.current.length - BUFFER);
      setLive((current) => {
        if (!current) return current;
        const { chat, unknownRun } = applyLiveEvent(current, event);
        if (unknownRun || endsRun(event)) refetchSoon();
        return chat;
      });
    });
  }, [chatId, cursor, watchChat, refetchSoon]);

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
    const known = new Set(
      live.entries.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : [])),
    );
    const extra: ChatEntry[] = sent
      .filter((message) => !known.has(message.id))
      .map((message) => ({ type: "message", at: message.createdAt, message }));
    return [...live.entries, ...extra].sort((a, b) => a.at.localeCompare(b.at));
  }, [live, sent]);

  return {
    chat: query.data?.chat ?? null,
    members: query.data?.members ?? [],
    entries,
    runs: live?.runs ?? {},
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    addSent,
  };
}
