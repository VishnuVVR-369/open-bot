/**
 * The vault's own lock, on top of the app's: opening the vault takes a fresh fingerprint (or the
 * phone's PIN), whether or not the app lock is on. It stays open for five minutes at most, and
 * locks as soon as the app leaves the screen, so coming back always asks again. The server never
 * sends a secret back; what this guards is what the vault shows (names, sites, usernames, the last
 * four digits, budgets and purchases) and the right to change it.
 */

/** How long the vault stays open after your fingerprint, while the app stays on screen. */
export const VAULT_OPEN_MS = 5 * 60_000;

export type UnlockResult =
  | { ok: true }
  /** You cancelled, or the check failed: ask again with the button. */
  | { ok: false; reason: "cancelled" }
  /** The phone has no screen lock, so there's nothing to check you with. */
  | { ok: false; reason: "no-screen-lock" };

export const NO_SCREEN_LOCK = "Set up a screen lock on this phone to open the vault from it.";

export interface VaultLockState {
  /** When you last unlocked it, or null while it's locked. */
  openedAt: number | null;
  /** Counts the times it locked, so a screen knows a lock happened since it last looked. */
  locks: number;
  /** The fingerprint prompt is up. */
  prompting: boolean;
}

export interface VaultLockDeps {
  now: () => number;
  /** Whether the phone has a screen lock or fingerprint to check you with. */
  canCheck: () => Promise<boolean>;
  /** Asks for your fingerprint or PIN; true when it's you. */
  check: () => Promise<boolean>;
  /** Timers, so the vault locks itself when its five minutes are up. */
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

export function createVaultLock(deps: VaultLockDeps) {
  let state: VaultLockState = { openedAt: null, locks: 0, prompting: false };
  let pending: Promise<UnlockResult> | null = null;
  let timer: unknown = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<VaultLockState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  function lock() {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    if (state.openedAt === null) return;
    set({ openedAt: null, locks: state.locks + 1 });
  }

  const isOpen = () => state.openedAt !== null && deps.now() - state.openedAt < VAULT_OPEN_MS;

  /** Asks for your fingerprint, once however many screens ask at the same time. */
  function unlock(): Promise<UnlockResult> {
    if (isOpen()) return Promise.resolve({ ok: true });
    pending ??= (async (): Promise<UnlockResult> => {
      set({ prompting: true });
      try {
        if (!(await deps.canCheck())) return { ok: false, reason: "no-screen-lock" };
        if (!(await deps.check())) return { ok: false, reason: "cancelled" };
        set({ openedAt: deps.now() });
        if (timer !== null) deps.clearTimer(timer);
        timer = deps.setTimer(lock, VAULT_OPEN_MS);
        return { ok: true };
      } catch {
        return { ok: false, reason: "cancelled" };
      } finally {
        pending = null;
        set({ prompting: false });
      }
    })();
    return pending;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    isOpen,
    unlock,
    lock,
    /**
     * The app left the screen. The PIN screen the prompt can fall back to is another app's, so
     * leaving for it while the prompt is up doesn't count.
     */
    backgrounded() {
      if (!state.prompting) lock();
    },
  };
}

export type VaultLock = ReturnType<typeof createVaultLock>;
