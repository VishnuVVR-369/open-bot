import { useFocusEffect } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import NativeEgress, { type EgressNativeStatus } from "../../../modules/egress";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";

/**
 * Where the computer's browser traffic goes now. The "computer" event refreshes it; while a screen
 * shows the counters, `live` also polls, since the relay doesn't announce every byte.
 */
export const useEgressStatus = (live = false) =>
  useQuery({
    queryKey: queryKeys.egress,
    queryFn: () => api.egress.status(),
    refetchInterval: live ? 10_000 : false,
  });

/**
 * Paired phones, with when the request started: a list says nothing about a pairing made after
 * its request began (see `removedOnServer`).
 */
export const useEgressDevices = () =>
  useQuery({
    queryKey: queryKeys.egressDevices,
    queryFn: async () => {
      const startedAt = Date.now();
      return { list: await api.egress.devices(), startedAt };
    },
  });

export interface NativeEgressState {
  status: EgressNativeStatus;
  notifications: { permission: boolean; connection: boolean };
  battery: { exempt: boolean; miui: boolean };
  standby: { enabled: boolean; exempt: boolean };
}

function readNative(): NativeEgressState {
  const allowed = NativeEgress.notificationsAllowed();
  return {
    status: NativeEgress.status(),
    notifications: { permission: allowed.permission, connection: allowed.connection },
    battery: NativeEgress.batteryOptimization(),
    standby: NativeEgress.lowPowerStandby(),
  };
}

/**
 * This phone's side: the service and its counters as they change, and what Android allows. The
 * owner fixes permissions in Android's settings, so they're read again whenever the app or the
 * screen comes back.
 */
export function useNativeEgress(): NativeEgressState & { refresh: () => void } {
  const [state, setState] = useState(readNative);
  const refresh = useCallback(() => setState(readNative()), []);
  useEffect(() => {
    const subscription = NativeEgress.addListener("status", (status) =>
      setState((current) => ({ ...current, status })),
    );
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });
    return () => {
      subscription.remove();
      appState.remove();
    };
  }, [refresh]);
  useFocusEffect(refresh);
  return { ...state, refresh };
}
