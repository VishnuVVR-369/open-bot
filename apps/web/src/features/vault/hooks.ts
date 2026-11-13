"use client";

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** Logins and cards, without their secrets. */
export function useVault() {
  return useQuery(orpc.vault.list.queryOptions());
}
