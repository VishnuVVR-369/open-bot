import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { api } from "@/lib/api";
import { queryClient, queryKeys } from "@/lib/query";

export const useChats = () =>
  useQuery({ queryKey: queryKeys.chats, queryFn: () => api.chats.list() });

/** Opens a new chat with a teammate. */
export function useNewDirectChat() {
  return useMutation({
    mutationFn: (botId: string) => api.chats.newDirect({ teammateId: botId }),
    onSuccess: ({ chatId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.teammates });
      router.push(`/chats/${chatId}`);
    },
  });
}
