"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** Memories that match `query`: one teammate's, or the shared ones when `botId` is null. */
export function useMemories(botId: string | null, query: string) {
  return useQuery(orpc.memory.list.queryOptions({ input: { botId, query: query.slice(0, 200) } }));
}

/** A memory's earlier versions, loaded while `memoryId` is set. */
export function useMemoryHistory(memoryId: string | null) {
  return useQuery(orpc.memory.history.queryOptions({ input: memoryId ? { memoryId } : skipToken }));
}

/** The memories a reply was given, loaded while `open`. */
export function useRunMemories(runId: string, open: boolean) {
  return useQuery(orpc.memory.forRun.queryOptions({ input: open ? { runId } : skipToken }));
}
