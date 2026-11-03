import * as Network from "expo-network";

/** Whether the phone is online. Unknown counts as online, so nothing is blocked by mistake. */
export function useOnline(): boolean {
  const state = Network.useNetworkState();
  return state.isConnected !== false && state.isInternetReachable !== false;
}
