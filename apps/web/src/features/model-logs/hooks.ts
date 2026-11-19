"use client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** Runs with model logs, newest first, a page at a time. */
export function useModelLogRuns() {
  return useInfiniteQuery(
    orpc.modelLogs.runs.infiniteOptions({
      input: (before: string | undefined) => ({ before }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextBefore ?? undefined,
    }),
  );
}

/** One run's turns, requests and tool calls. */
export function useRunModelLogs(runId: string) {
  return useQuery(orpc.modelLogs.run.queryOptions({ input: { runId } }));
}

/** One request's bodies, only once it is opened. */
export function useRequestBodies(requestId: string, open: boolean) {
  return useQuery({
    ...orpc.modelLogs.request.queryOptions({ input: { requestId } }),
    enabled: open,
    staleTime: Infinity,
  });
}

/** A run's Codex messages, only once their section is opened. */
export function useRunEvents(runId: string, open: boolean) {
  return useQuery({ ...orpc.modelLogs.events.queryOptions({ input: { runId } }), enabled: open });
}

/** One Codex message's payload, only once it is opened. */
export function useRunEvent(eventId: string, open: boolean) {
  return useQuery({
    ...orpc.modelLogs.event.queryOptions({ input: { eventId } }),
    enabled: open,
    staleTime: Infinity,
  });
}
