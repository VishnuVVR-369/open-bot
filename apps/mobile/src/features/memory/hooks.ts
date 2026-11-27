import type { MemoryItem } from "@open-bot/domain";
import { skipToken, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryClient, queryKeys } from "@/lib/query";

/** Memories matching `query`: one teammate's, or the shared ones with `teammateId` null. */
export const useMemories = (teammateId: string | null, query: string) =>
  useQuery({
    queryKey: queryKeys.memories(teammateId, query),
    queryFn: () => api.memory.list({ teammateId, query: query.slice(0, 200) }),
    // Typing a search keeps the last results on screen until the new ones come.
    placeholderData: (previous) => previous,
  });

/** A copy of a memory from any list already loaded, to open it at once. */
function listed(memoryId: string): MemoryItem | undefined {
  for (const [, items] of queryClient.getQueriesData<MemoryItem[]>({
    queryKey: [...queryKeys.allMemory, "list"],
  })) {
    const item = items?.find((entry) => entry.id === memoryId);
    if (item) return item;
  }
  return undefined;
}

/** One memory, read on its own so a link or an old one opens too, shown at once from a list. */
export const useMemory = (memoryId: string) =>
  useQuery({
    queryKey: queryKeys.memory(memoryId),
    queryFn: () => api.memory.get({ memoryId }),
    placeholderData: () => listed(memoryId),
  });

/** A memory's revisions, newest first. */
export const useMemoryHistory = (memoryId: string) =>
  useQuery({
    queryKey: queryKeys.memoryHistory(memoryId),
    queryFn: () => api.memory.history({ memoryId }),
  });

/** The memories a reply was given, read while `open`. */
export const useRunMemory = (runId: string, open: boolean) =>
  useQuery({
    queryKey: queryKeys.runMemory(runId),
    queryFn: open ? () => api.memory.forRun({ runId }) : skipToken,
  });

/** What a teammate learned from your feedback, newest first. */
export const useLessons = (teammateId: string) =>
  useQuery({
    queryKey: queryKeys.lessons(teammateId),
    queryFn: () => api.teammates.lessons({ teammateId }),
  });
