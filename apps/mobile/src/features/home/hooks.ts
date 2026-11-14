import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { usePresence } from "@/lib/presence";

/** Home, with what teammates finished since you were last here. */
export function useHome() {
  const { awaySince } = usePresence();
  return useQuery({
    queryKey: [...queryKeys.home, awaySince],
    queryFn: () => api.home.get({ awaySince }),
    placeholderData: (previous) => previous,
  });
}
