"use client";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

export function useNotifications(enabled = true) {
  return useQuery(orpc.notifications.list.queryOptions({ enabled }));
}
