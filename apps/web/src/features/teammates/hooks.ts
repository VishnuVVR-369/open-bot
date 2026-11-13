"use client";

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** A teammate's budget, what it spent this month and its recent purchases. */
export function useSpending(teammateId: string) {
  return useQuery(orpc.teammates.spending.queryOptions({ input: { botId: teammateId } }));
}
