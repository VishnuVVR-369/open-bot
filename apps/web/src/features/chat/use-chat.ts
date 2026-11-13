"use client";

import { applyLiveEvent, endsRun, liveChatFromSnapshot, type LiveChat } from "@open-bot/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { orpc } from "@/lib/client/rpc";
import { setVisibleChat, useRealtime } from "@/lib/client/realtime";
import type { ChatEntry, MessageView, StreamRunEvent } from "@/lib/types";

type ChatState = LiveChat;

const BUFFER = 2_000;

/** A chat's messages and runs, kept live with the realtime stream. */
export function useChat(chatId: string) {
  const queryClient = useQueryClient();
  const { watchChat } = useRealtime();
  const query = useQuery(orpc.chats.get.queryOptions({ input: { chatId } }));
  const [state, setState] = useState<ChatState | null>(null);
  const [optimistic, setOptimistic] = useState<MessageView[]>([]);
  const buffer = useRef<StreamRunEvent[]>([]);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetchSoon = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: orpc.chats.get.key({ input: { chatId } }) });
    }, 150);
  }, [chatId, queryClient]);

  useEffect(() => {
    setVisibleChat(chatId);
    return () => setVisibleChat(null);
  }, [chatId]);

  useEffect(() => {
    buffer.current = [];
    setState(null);
    setOptimistic([]);
  }, [chatId]);

  // Rebuild from each snapshot.
  useEffect(() => {
    if (!query.data) return;
    const { chat: next, unknownRun } = liveChatFromSnapshot(query.data, buffer.current);
    setState(next);
    setOptimistic((current) =>
      current.filter(
        (message) =>
          !next.entries.some(
            (entry) => entry.type === "message" && entry.message.id === message.id,
          ),
      ),
    );
    if (unknownRun) refetchSoon();
  }, [query.data, refetchSoon]);

  // Apply live events.
  const cursor = query.data?.cursor;
  useEffect(() => {
    if (cursor === undefined) return;
    return watchChat(chatId, cursor, (event) => {
      buffer.current.push(event);
      if (buffer.current.length > BUFFER) buffer.current.splice(0, buffer.current.length - BUFFER);
      setState((current) => {
        if (!current) return current;
        const { chat: next, unknownRun } = applyLiveEvent(current, event);
        // Pick up the final row state (completion time, final text), or a run that just started.
        if (unknownRun || endsRun(event)) refetchSoon();
        return next;
      });
    });
  }, [chatId, cursor, watchChat, refetchSoon]);

  const addOptimistic = useCallback((message: MessageView) => {
    setOptimistic((current) => [...current, message]);
  }, []);

  const entries = useMemo(() => {
    if (!state) return [];
    const known = new Set(
      state.entries
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: MessageView }).message.id),
    );
    const extra: ChatEntry[] = optimistic
      .filter((message) => !known.has(message.id))
      .map((message) => ({ type: "message", at: message.createdAt, message }));
    return [...state.entries, ...extra].sort((a, b) => a.at.localeCompare(b.at));
  }, [state, optimistic]);

  return {
    chat: query.data?.chat ?? null,
    members: query.data?.members ?? [],
    hasMore: query.data?.hasMore ?? false,
    helper: query.data?.helper ?? null,
    entries,
    runs: state?.runs ?? {},
    loading: query.isLoading,
    error: query.error,
    addOptimistic,
    refresh: refetchSoon,
  };
}
