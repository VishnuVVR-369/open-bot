import { vaultEditorTitle, type VaultKind } from "@open-bot/domain";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/query";

/**
 * The vault gate's decisions, apart from React and the phone, so they can be tested: which screens
 * count as being in the vault, when it asks for your fingerprint, and what leaving it drops.
 */

/**
 * How long leaving the last vault screen waits before it counts: moving between vault screens
 * (the list opening an editor, an editor replacing itself with the list) blurs one a moment
 * before the next is focused, and that isn't leaving.
 */
export const VAULT_SETTLE_MS = 1_000;

export interface VaultScreensDeps {
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** The first vault screen is in front: hide the app from screenshots. */
  hide: () => void;
  /** The vault was left: show the app to screenshots again, lock the vault and forget it. */
  left: () => void;
}

/**
 * Counts the vault screens in front (focused, not just mounted: a chat opened from a purchase
 * sits over the budget screen, which stays mounted under it). The first one hides the app from
 * screenshots; once none is left for `VAULT_SETTLE_MS`, the vault is left.
 */
export function createVaultScreens(deps: VaultScreensDeps) {
  let count = 0;
  let hidden = false;
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  /** A vault screen came to the front. Returns its going away, which only counts once. */
  function enter(): () => void {
    count += 1;
    cancel();
    if (!hidden) {
      hidden = true;
      deps.hide();
    }
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      count -= 1;
      if (count > 0) return;
      cancel();
      timer = deps.setTimer(() => {
        timer = null;
        if (count > 0) return;
        hidden = false;
        deps.left();
      }, VAULT_SETTLE_MS);
    };
  }

  return { enter, count: () => count, hidden: () => hidden };
}

export type VaultScreens = ReturnType<typeof createVaultScreens>;

/** Drops everything the vault read (its items, every teammate's spending), once you leave it. */
export function forgetVault(client: QueryClient) {
  client.removeQueries({ queryKey: queryKeys.allVault });
  client.removeQueries({ queryKey: queryKeys.allSpending });
}

/**
 * Whether this screen asks for your fingerprint on its own now: only where you'd expect it, as you
 * come in or come back to the app, never while it's open already, behind another screen, or with
 * the app away from the screen.
 */
export function shouldAskHere(state: { open: boolean; focused: boolean; active: boolean }) {
  return !state.open && state.focused && state.active;
}

/**
 * The app came back: whether the vault asks now, or leaves it to the app's own lock, which asks
 * first after five minutes away when it's on (and the vault asks once that lets you in).
 */
export function asksOnReturn(state: {
  appLock: boolean;
  appRelocks: (backgroundedAt: number | null, now: number) => boolean;
  backgroundedAt: number | null;
  now: number;
}) {
  return !(state.appLock && state.appRelocks(state.backgroundedAt, state.now));
}

/** The header: an item's name only while the vault is open, so a locked screen doesn't show it. */
export function vaultEditorHeader(kind: VaultKind, name: string | null, open: boolean): string {
  if (name === null || open) return vaultEditorTitle(kind, name);
  return kind === "login" ? "Edit login" : "Edit card";
}
