import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";

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
