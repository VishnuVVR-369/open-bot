"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client/rpc";

export function useSchedules() {
  return useQuery(orpc.schedules.list.queryOptions());
}

/** A schedule's recent runs, loaded when you open its history. */
export function useScheduleRuns(scheduleId: string, enabled: boolean) {
  return useQuery(
    orpc.schedules.runs.queryOptions({ input: enabled ? { scheduleId } : skipToken }),
  );
}

export function useTriggers() {
  return useQuery(orpc.triggers.list.queryOptions());
}

/** A watch's or webhook's recent runs, loaded when you open its history. */
export function useTriggerRuns(triggerId: string, enabled: boolean) {
  return useQuery(orpc.triggers.runs.queryOptions({ input: enabled ? { triggerId } : skipToken }));
}
