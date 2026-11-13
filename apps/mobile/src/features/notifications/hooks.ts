import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export const useNotifications = () =>
  useQuery({ queryKey: queryKeys.notifications, queryFn: () => api.notifications.list() });
