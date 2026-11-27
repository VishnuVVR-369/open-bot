import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { automationSections, findAutomation, type AutomationType } from "./automations";

export const useSchedules = () =>
  useQuery({ queryKey: queryKeys.schedules, queryFn: () => api.schedules.list() });

/** Page watches, webhooks, and Gmail and Calendar triggers. */
export const useTriggers = () =>
  useQuery({ queryKey: queryKeys.triggers, queryFn: () => api.triggers.list() });

/** Everyone's automations, or one teammate's, by section, with both lists' loading state. */
export function useAutomationSections(teammateId: string | null = null) {
  const schedules = useSchedules();
  const triggers = useTriggers();
  const sections = useMemo(
    () =>
      schedules.data && triggers.data
        ? automationSections(schedules.data, triggers.data, teammateId)
        : null,
    [schedules.data, triggers.data, teammateId],
  );
  return {
    sections,
    isLoading: schedules.isLoading || triggers.isLoading,
    error: schedules.error ?? triggers.error,
    refetch: () => Promise.all([schedules.refetch(), triggers.refetch()]),
  };
}

/**
 * One automation, as the list the server last sent has it. `gone` only once a list read after it
 * no longer has it, never while the list is loading or failed to load.
 */
export function useAutomation(type: AutomationType, id: string) {
  const schedules = useSchedules();
  const triggers = useTriggers();
  const query = type === "schedule" ? schedules : triggers;
  const automation = useMemo(
    () => findAutomation(type, id, schedules.data, triggers.data),
    [type, id, schedules.data, triggers.data],
  );
  return {
    automation,
    gone: Boolean(query.data) && !automation,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/** An automation's latest runs, newest first. */
export function useAutomationRuns(type: AutomationType, id: string) {
  return useQuery({
    queryKey: type === "schedule" ? queryKeys.scheduleRuns(id) : queryKeys.triggerRuns(id),
    queryFn: () =>
      type === "schedule"
        ? api.schedules.runs({ scheduleId: id })
        : api.triggers.runs({ triggerId: id }),
  });
}
