"use client";
import type { ModelLogRunFilters } from "@open-bot/api";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

/** Runs with model logs, newest first, a page at a time, narrowed by the filters. */
export function useModelLogRuns(filters: ModelLogRunFilters = {}) {
  return useInfiniteQuery({
    ...orpc.modelLogs.runs.infiniteOptions({
      input: (before: string | undefined) => ({ ...filters, before }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextBefore ?? undefined,
    }),
    // A new filter keeps the last list on screen until its own arrives.
    placeholderData: keepPreviousData,
  });
}

/** The teammates, chats and models the runs list can be narrowed to. */
export function useModelLogFilterOptions() {
  return useQuery(orpc.modelLogs.filters.queryOptions());
}

type ToolsInput = { from?: string; to?: string; teammateId?: string };

/** Each tool's calls, failures and duration over a range. */
export function useToolStats(input: ToolsInput) {
  return useQuery({
    ...orpc.modelLogs.tools.queryOptions({ input }),
    placeholderData: keepPreviousData,
  });
}

/** Failed tool calls over a range, newest first, a page at a time. */
export function useToolFailures(input: ToolsInput & { tool?: string }) {
  return useInfiniteQuery({
    ...orpc.modelLogs.toolFailures.infiniteOptions({
      input: (before: string | undefined) => ({ ...input, before }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextBefore ?? undefined,
    }),
    placeholderData: keepPreviousData,
  });
}

/** Tokens, cost, errors and plan windows over a range. */
export function useModelLogUsage(input: { from: string; to: string }) {
  return useQuery({
    ...orpc.modelLogs.usage.queryOptions({ input }),
    placeholderData: keepPreviousData,
  });
}

/** How long model logs keep their bodies, and how far the sweeps have got. */
export function useModelLogRetention() {
  return useQuery(orpc.modelLogs.retention.queryOptions());
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
