import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export const useTeammates = () =>
  useQuery({ queryKey: queryKeys.teammates, queryFn: () => api.teammates.list() });
