import { useState } from "react";

/**
 * Pull to refresh: `refetch` reloads what the screen shows, and the spinner stays until it's back.
 * Pass `onRefresh` (wrapped in `void`) and `refreshing` to the list's `RefreshControl`.
 */
export function usePullToRefresh(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  async function onRefresh() {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }
  return { refreshing, onRefresh };
}
