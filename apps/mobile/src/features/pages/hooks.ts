import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export const usePages = () =>
  useQuery({ queryKey: queryKeys.pages, queryFn: () => api.pages.list() });
