import * as Network from "expo-network";
import { reachable } from "./reachable";

/** Whether the phone is online. Unknown counts as online, so nothing is blocked by mistake. */
export function useOnline(): boolean {
  return reachable(Network.useNetworkState());
}

/**
 * Whether the phone is online right now, read fresh: for a write you confirmed in a dialog, since
 * the connection may have dropped while it was open. A failed read counts as online.
 */
export async function onlineNow(): Promise<boolean> {
  try {
    return reachable(await Network.getNetworkStateAsync());
  } catch {
    return true;
  }
}
