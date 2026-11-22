import type { TaskView } from "@open-bot/api";
import { PendingMoves, taskBlocker, withPendingMoves, type BlockerFacts } from "@open-bot/domain";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useApprovals } from "@/features/approvals/hooks";
import { useComputerOffline } from "@/features/computer/hooks";
import { useHome } from "@/features/home/hooks";
import { api } from "@/lib/api";
import { queryClient, queryKeys } from "@/lib/query";

/** The moves this phone sent that the board it last read doesn't have yet. */
export const pendingMoves = new PendingMoves();

/**
 * The team's board: open tasks in board order, and the 30 most recently finished, with the moves
 * still on their way laid over the board the server last sent (`PendingMoves`).
 */
export function useTasks() {
  const query = useQuery({ queryKey: queryKeys.tasks, queryFn: () => api.tasks.list() });
  const moves = useSyncExternalStore(pendingMoves.subscribe, pendingMoves.snapshot);
  const { data: board, dataUpdatedAt } = query;
  useEffect(() => {
    if (dataUpdatedAt) pendingMoves.confirmed(dataUpdatedAt);
  }, [dataUpdatedAt]);
  const data = useMemo(
    () => board && withPendingMoves(board, moves, dataUpdatedAt),
    [board, moves, dataUpdatedAt],
  );
  return { ...query, data };
}

/**
 * One task, by id, whatever its column: the board lists only the latest finished tasks. It opens
 * at once from the board's copy, then reads the task itself.
 */
export const useTask = (taskId: string) =>
  useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => api.tasks.get({ taskId }),
    placeholderData: () =>
      queryClient.getQueryData<TaskView[]>(queryKeys.tasks)?.find((task) => task.id === taskId),
  });

/**
 * What holds each task up, from what's waiting on you (approvals, take overs) and whether the
 * computer is online, by the board's shared rule.
 */
export function useTaskBlockers() {
  const { data: approvals } = useApprovals();
  const { data: home } = useHome();
  const computerOffline = useComputerOffline();
  const facts = useMemo<BlockerFacts>(
    () => ({
      approvalChatIds: new Set(
        (approvals ?? []).flatMap((approval) =>
          approval.status === "pending" ? [approval.chatId] : [],
        ),
      ),
      takeoverChatIds: new Set(
        (home?.takeoverRequests ?? []).flatMap((request) =>
          request.chatId ? [request.chatId] : [],
        ),
      ),
      online: !computerOffline,
    }),
    [approvals, home?.takeoverRequests, computerOffline],
  );
  return useCallback((task: TaskView) => taskBlocker(task, facts), [facts]);
}

/** Your name, whose initial marks your own tasks as the web's board does. */
export function useYourName(): string {
  const { data: home } = useHome();
  return home?.user.name ?? "You";
}
