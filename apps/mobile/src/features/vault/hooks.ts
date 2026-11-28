import { useQueries, useQuery } from "@tanstack/react-query";
import * as LocalAuthentication from "expo-local-authentication";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { api } from "@/lib/api";
import { queryClient, queryKeys } from "@/lib/query";
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

AppState.addEventListener("change", (state) => {
  if (state === "background") vaultLock.backgrounded();
});

export function useVaultLock() {
  return useSyncExternalStore(vaultLock.subscribe, vaultLock.getState);
}

let screens = 0;

/**
 * Counts the vault's screens that are open. When the last one closes, the vault locks and what
 * it read (items, budgets, purchases) is dropped from memory, so nothing of it is left behind.
 */
export function useVaultScreen() {
  useEffect(() => {
    screens += 1;
    return () => {
      screens -= 1;
      // Checked once the navigation settles: an editor that replaces itself with the vault
      // closes as the vault opens, and that isn't leaving.
      setTimeout(() => {
        if (screens > 0) return;
        vaultLock.lock();
        forgetVault();
      }, 1_000);
    };
  }, []);
}

/** Drops everything the vault read. */
export function forgetVault() {
  queryClient.removeQueries({ queryKey: queryKeys.allVault });
  queryClient.removeQueries({ queryKey: queryKeys.allSpending });
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
