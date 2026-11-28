/**
 * Whether a network state counts as online. Unknown counts as online, so nothing is blocked by
 * mistake; only the phone saying it has no connection, or can't reach the internet, is offline.
 */
export const reachable = (state: {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
}): boolean => state.isConnected !== false && state.isInternetReachable !== false;
