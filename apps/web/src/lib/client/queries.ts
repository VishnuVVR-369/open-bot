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
  AccountsSetupView,
  ConnectionView,
  PageDetail,
  PageLink,
  PageSummary,
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
  pages: ["pages"] as const,
  page: (pageId: string) => ["pages", pageId] as const,
  pageLink: (versionId: string, theme: string, ask: boolean) =>
    ["page-link", versionId, theme, ask] as const,
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

export function useAccountsSetup() {
  return useQuery({
    // Under connections, so the same live updates refresh it.
    queryKey: [...queryKeys.connections, "setup"],
    queryFn: () => getJson<AccountsSetupView>("/api/accounts/setup"),
  });
}

export function usePages() {
  return useQuery({
    queryKey: queryKeys.pages,
    queryFn: () => getJson<PageSummary[]>("/api/pages"),
  });
}

export function usePage(pageId: string) {
  return useQuery({
    queryKey: queryKeys.page(pageId),
    queryFn: () => getJson<PageDetail>(`/api/pages/${pageId}`),
    retry: (count, error) => !/deleted/.test(error.message) && count < 2,
  });
}

/** Where to show a version. Links work for a few minutes, so a page reopened later gets a new one. */
export function pageLinkUrl(versionId: string, options: { theme?: string; ask?: boolean }) {
  const params = new URLSearchParams();
  if (options.theme) params.set("theme", options.theme);
  if (options.ask) params.set("ask", "1");
  return `/api/pages/versions/${versionId}/link?${params}`;
}

export function usePageLink(versionId: string | null, theme: "light" | "dark", ask: boolean) {
  return useQuery({
    queryKey: queryKeys.pageLink(versionId ?? "", theme, ask),
    queryFn: () => getJson<PageLink>(pageLinkUrl(versionId!, { theme, ask })),
    enabled: versionId !== null,
    // Loaded once into the frame, which keeps working after the link expires. Coming back to it
    // later (another theme and back, or the page again) gets a new link once this one is near its end.
    staleTime: (query) =>
      query.state.data
        ? Math.max(0, Date.parse(query.state.data.expiresAt) - Date.now() - 60_000)
        : 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** False while the computer (the worker) is offline, so views skip requests that would fail. */
export function useComputerOnline(): boolean | undefined {
  const { data: state } = useAppState();
  return state?.computer.workerOnline;
}
