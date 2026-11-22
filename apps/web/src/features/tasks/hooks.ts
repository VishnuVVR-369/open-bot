"use client";

import { withPendingMoves } from "@open-bot/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { orpc } from "@/lib/client/rpc";
import { pendingMoves } from "./pending";

/**
 * The task board: open tasks in order, and the 30 most recently finished, with the moves still
 * on their way laid over the board the server last sent (`PendingMoves`).
 */
export function useTasks() {
  const query = useQuery(orpc.tasks.list.queryOptions());
  const moves = useSyncExternalStore(
    pendingMoves.subscribe,
    pendingMoves.snapshot,
    pendingMoves.snapshot,
  );
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
