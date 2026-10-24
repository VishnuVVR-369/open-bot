"use client";

import { applyRunEvent } from "@open-bot/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson } from "@/lib/client/api";
import { queryKeys } from "@/lib/client/queries";
import { setVisibleChat, useRealtime } from "@/lib/client/realtime";
import type { ChatData, ChatEntry, MessageView, RunView, StreamRunEvent } from "@/lib/types";

interface ChatState {
  entries: ChatEntry[];
  runs: Record<string, RunView>;
  cursor: number;
}

const BUFFER = 2_000;

function fromSnapshot(
  data: ChatData,
  buffered: StreamRunEvent[],
): { state: ChatState; unknownRun: boolean } {
  const runs: Record<string, RunView> = {};
  for (const entry of data.entries) if (entry.type === "run") runs[entry.run.id] = entry.run;
  let unknownRun = false;
  // Events that arrived after the snapshot was taken still need applying.
  for (const event of buffered) {
    if (event.id <= data.cursor) continue;
    const run = runs[event.runId];
    if (!run) {
      unknownRun = true;
      continue;
    }
    runs[event.runId] = { ...run, timeline: applyRunEvent(run.timeline, event.payload) };
  }
  return { state: { entries: data.entries, runs, cursor: data.cursor }, unknownRun };
}

/** A chat's messages and runs, kept live with the realtime stream. */
export function useChat(chatId: string) {
  const queryClient = useQueryClient();
  const { watchChat } = useRealtime();
  const query = useQuery({
    queryKey: queryKeys.chat(chatId),
    queryFn: () => getJson<ChatData>(`/api/chats/${chatId}`),
  });
  const [state, setState] = useState<ChatState | null>(null);
  const [optimistic, setOptimistic] = useState<MessageView[]>([]);
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
    const { state: next, unknownRun } = fromSnapshot(query.data, buffer.current);
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
        const run = current.runs[event.runId];
        if (!run) {
          refetchSoon();
          return current;
        }
        if (
          event.payload.type === "status" &&
          ["completed", "failed", "interrupted"].includes(event.payload.status)
        ) {
          // Pick up the final row state (completion time, final text).
          refetchSoon();
        }
        return {
          ...current,
          cursor: Math.max(current.cursor, event.id),
          runs: {
            ...current.runs,
            [event.runId]: { ...run, timeline: applyRunEvent(run.timeline, event.payload) },
          },
        };
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
