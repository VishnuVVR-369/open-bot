import type { TaskView } from "@open-bot/api";
import { taskBlocker, type BlockerFacts } from "@open-bot/domain";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useApprovals } from "@/features/approvals/hooks";
import { useComputerOffline } from "@/features/computer/hooks";
import { useHome } from "@/features/home/hooks";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";

/** The team's board: open tasks in board order, and the 30 most recently finished. */
export const useTasks = () =>
  useQuery({ queryKey: queryKeys.tasks, queryFn: () => api.tasks.list() });

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
