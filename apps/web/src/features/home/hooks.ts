"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** Home: recent work, and what finished since `awaySince` (a time in milliseconds) if given. */
export function useHome(awaySince: number | null) {
  return useQuery(
    orpc.home.get.queryOptions({
      input: { awaySince: awaySince === null ? null : new Date(awaySince).toISOString() },
      // Recent work stays on screen while the briefing starts or ends.
      placeholderData: keepPreviousData,
    }),
  );
}
