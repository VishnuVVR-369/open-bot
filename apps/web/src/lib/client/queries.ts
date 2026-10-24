"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  LessonView,
  TaskView,
  ActivityView,
  AppState,
  ApprovalView,
  NotificationView,
  ProfileView,
  ScheduleRunView,
  ScheduleView,
  SkillView,
  SpendingView,
  TriggerView,
  VaultItemView,
  ConnectionView,
} from "../types";
import { getJson } from "./api";

export const queryKeys = {
  state: ["state"] as const,
  chat: (chatId: string) => ["chat", chatId] as const,
  notifications: ["notifications"] as const,
  approvals: ["approvals"] as const,
  schedules: ["schedules"] as const,
  scheduleRuns: (scheduleId: string) => ["schedules", scheduleId, "runs"] as const,
  triggers: ["triggers"] as const,
  triggerRuns: (triggerId: string) => ["triggers", triggerId, "runs"] as const,
  skills: ["skills"] as const,
  profile: ["profile"] as const,
  lessons: (botId: string) => ["lessons", botId] as const,
  tasks: ["tasks"] as const,
  telegram: ["telegram"] as const,
  activity: ["activity"] as const,
  files: (path: string) => ["files", path] as const,
  vault: ["vault"] as const,
  connections: ["connections"] as const,
  email: ["email"] as const,
  spending: (botId: string) => ["spending", botId] as const,
};

export function useAppState(initial?: AppState) {
  return useQuery({
    queryKey: queryKeys.state,
    queryFn: () => getJson<AppState>("/api/state"),
    initialData: initial,
    refetchInterval: 15_000,
  });
}

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => getJson<NotificationView[]>("/api/notifications"),
    enabled,
  });
}

export function useApprovals() {
  return useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () => getJson<ApprovalView[]>("/api/approvals"),
  });
}

export function useSchedules() {
  return useQuery({
    queryKey: queryKeys.schedules,
    queryFn: () => getJson<ScheduleView[]>("/api/schedules"),
  });
}

/** A schedule's recent runs, loaded when you open its history. */
export function useScheduleRuns(scheduleId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.scheduleRuns(scheduleId),
    queryFn: () => getJson<ScheduleRunView[]>(`/api/schedules/${scheduleId}/runs`),
    enabled,
  });
}

export function useTriggers() {
  return useQuery({
    queryKey: queryKeys.triggers,
    queryFn: () => getJson<TriggerView[]>("/api/triggers"),
  });
}

/** A watch's or webhook's recent runs, loaded when you open its history. */
export function useTriggerRuns(triggerId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.triggerRuns(triggerId),
    queryFn: () => getJson<ScheduleRunView[]>(`/api/triggers/${triggerId}/runs`),
    enabled,
  });
}

export function useActivity() {
  return useQuery({
    queryKey: queryKeys.activity,
    queryFn: () => getJson<ActivityView[]>("/api/activity"),
  });
}

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: () => getJson<SkillView[]>("/api/skills"),
  });
}

export function useTasks() {
  return useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => getJson<TaskView[]>("/api/tasks"),
  });
}

export function useLessons(botId: string) {
  return useQuery({
    queryKey: queryKeys.lessons(botId),
    queryFn: () => getJson<LessonView[]>(`/api/bots/${botId}/lessons`),
  });
}

export function useProfile() {
  return useQuery({
    queryKey: queryKeys.profile,
    queryFn: () => getJson<ProfileView>("/api/profile"),
  });
}

export function useVault() {
  return useQuery({
    queryKey: queryKeys.vault,
    queryFn: () => getJson<VaultItemView[]>("/api/vault"),
  });
}

export function useSpending(botId: string) {
  return useQuery({
    queryKey: queryKeys.spending(botId),
    queryFn: () => getJson<SpendingView>(`/api/bots/${botId}/spending`),
  });
}

export function useConnections() {
  return useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => getJson<ConnectionView[]>("/api/connections"),
  });
}
