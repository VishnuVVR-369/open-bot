"use client";

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

export function useConnections() {
  return useQuery(orpc.connections.list.queryOptions());
}

export function useAccountsSetup() {
  return useQuery(orpc.accounts.setup.queryOptions());
}
