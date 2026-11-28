import { useQueries, useQuery } from "@tanstack/react-query";
import * as LocalAuthentication from "expo-local-authentication";
import { useFocusEffect } from "expo-router";
import { useCallback, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { api } from "@/lib/api";
import { queryClient, queryKeys } from "@/lib/query";
import { allowScreenCapture, preventScreenCapture } from "@/lib/screen-capture";
import { createVaultScreens, forgetVault } from "./gate";
import { createVaultLock } from "./unlock";

/** The vault's lock, one for the app: every vault screen opens and locks together. */
export const vaultLock = createVaultLock({
  now: Date.now,
  canCheck: async () =>
    (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE,
  check: async () =>
    (
      await LocalAuthentication.authenticateAsync({
        promptMessage: "Open the vault",
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      })
    ).success,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});

AppState.addEventListener("change", (state) => vaultLock.appState(state));

export function useVaultLock() {
  return useSyncExternalStore(vaultLock.subscribe, vaultLock.getState);
}

/**
 * The vault screens in front. While one is, the app stays out of screenshots, recordings and the
 * recent apps preview; once none is, the vault locks and what it read (items, budgets, purchases)
 * is dropped from memory, so nothing of it is left behind.
 */
const vaultScreens = createVaultScreens({
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  hide: preventScreenCapture,
  left: () => {
    allowScreenCapture();
    vaultLock.lock();
    forgetVault(queryClient);
  },
});

/**
 * Counts this screen as being in the vault while it's in front: focused, not merely mounted, so a
 * chat opened from a purchase, over the budget screen, leaves the vault.
 */
export function useVaultScreen() {
  useFocusEffect(useCallback(() => vaultScreens.enter(), []));
}

/** Logins and cards, without their secrets. Read only once the vault is open. */
export const useVaultItems = () =>
  useQuery({ queryKey: queryKeys.vault, queryFn: () => api.vault.list() });

/** A teammate's budget, what it spent this month and its recent purchases. */
export const useSpending = (teammateId: string) =>
  useQuery({
    queryKey: queryKeys.spending(teammateId),
    queryFn: () => api.teammates.spending({ teammateId }),
  });

/** Each teammate's spending, for the vault's budgets. */
export const useAllSpending = (teammateIds: readonly string[]) =>
  useQueries({
    queries: teammateIds.map((teammateId) => ({
      queryKey: queryKeys.spending(teammateId),
      queryFn: () => api.teammates.spending({ teammateId }),
    })),
  });
