"use client";

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** Waiting approvals first, then the latest decided ones, newest first (100 in all). */
export function useApprovals() {
  return useQuery(orpc.approvals.list.queryOptions());
}
