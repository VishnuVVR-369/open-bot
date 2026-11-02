import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { api } from "./api";
import { queryClient, queryKeys } from "./query";

export const useTeammates = () =>
  useQuery({ queryKey: queryKeys.teammates, queryFn: () => api.teammates.list() });

export const useChats = () =>
  useQuery({ queryKey: queryKeys.chats, queryFn: () => api.chats.list() });

export const useApprovals = () =>
  useQuery({ queryKey: queryKeys.approvals, queryFn: () => api.approvals.list() });

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
