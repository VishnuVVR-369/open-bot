import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { api } from "./api";
import { usePresence } from "./presence";
import { queryClient, queryKeys } from "./query";

export const useTeammates = () =>
  useQuery({ queryKey: queryKeys.teammates, queryFn: () => api.teammates.list() });

export const useChats = () =>
  useQuery({ queryKey: queryKeys.chats, queryFn: () => api.chats.list() });

export const useApprovals = () =>
  useQuery({ queryKey: queryKeys.approvals, queryFn: () => api.approvals.list() });

export const useApprovalRules = () =>
  useQuery({ queryKey: queryKeys.approvalRules, queryFn: () => api.approvals.rules() });

export const useNotifications = () =>
  useQuery({ queryKey: queryKeys.notifications, queryFn: () => api.notifications.list() });

export const useScreens = () =>
  useQuery({ queryKey: queryKeys.screens, queryFn: () => api.screens.list() });

/**
 * True while the computer is known to be offline, so nothing claims work is happening. Every
 * screen lives on the one computer, so they all say the same; with no screens it isn't known.
 */
export function useComputerOffline(): boolean {
  const { data } = useScreens();
  return Boolean(data && data.length > 0 && data.every((screen) => !screen.online));
}

export const usePages = () =>
  useQuery({ queryKey: queryKeys.pages, queryFn: () => api.pages.list() });

/** Home, with what teammates finished since you were last here. */
export function useHome() {
  const { awaySince } = usePresence();
  return useQuery({
    queryKey: [...queryKeys.home, awaySince],
    queryFn: () => api.home.get({ awaySince }),
    placeholderData: (previous) => previous,
  });
}

/** Opens a new chat with a teammate. */
export function useNewDirectChat() {
  return useMutation({
    mutationFn: (botId: string) => api.chats.newDirect({ botId }),
    onSuccess: ({ chatId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.teammates });
      router.push(`/chats/${chatId}`);
    },
  });
}
