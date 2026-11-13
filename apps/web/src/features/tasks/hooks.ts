"use client";

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** The task board: open tasks in order, and the 30 most recently finished. */
export function useTasks() {
  return useQuery(orpc.tasks.list.queryOptions());
}
