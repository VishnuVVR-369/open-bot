import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { usePresence } from "./presence";
import { queryKeys } from "./query";

export const useTeammates = () =>
  useQuery({ queryKey: queryKeys.teammates, queryFn: () => api.teammates.list() });

export const useNotifications = () =>
  useQuery({ queryKey: queryKeys.notifications, queryFn: () => api.notifications.list() });

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
