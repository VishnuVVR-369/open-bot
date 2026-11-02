import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

/** How long the app may sit in the background before it asks for your fingerprint again. */
export const RELOCK_AFTER_MS = 5 * 60_000;

export function shouldRelock(backgroundedAt: number | null, now: number): boolean {
  return backgroundedAt !== null && now - backgroundedAt >= RELOCK_AFTER_MS;
}

/**
 * Asks for your fingerprint (or the phone's PIN) when the app opens, and when it comes back after
 * five minutes away. The session itself lasts 30 days; this guards the phone, not the account.
 * Phones without a screen lock can't do this, so they aren't locked. Signing in with your
 * password proves it's you already, so that doesn't lock either.
 */
export function useAppLock(session: "pending" | "signedIn" | "signedOut") {
  const signedIn = session === "signedIn";
  // Signed out at some point since the app opened: the next sign-in was with your password.
  const signedOutSinceOpen = useRef(false);
  if (session === "signedOut") signedOutSinceOpen.current = true;
  const [locked, setLockedState] = useState(false);
  const [checking, setChecking] = useState(true);
  const lockedNow = useRef(false);
  const backgroundedAt = useRef<number | null>(null);
  const prompting = useRef(false);
  const interrupted = useRef(false);
  const setLocked = useCallback((value: boolean) => {
    lockedNow.current = value;
    setLockedState(value);
  }, []);

  const unlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock open-bot",
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      });
      if (result.success) setLocked(false);
      // Cancelled because the app left the screen, not by you: ask again when it's back.
      interrupted.current = !result.success && AppState.currentState !== "active";
    } finally {
      prompting.current = false;
    }
  }, [setLocked]);

  const lockIfSecured = useCallback(async () => {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return false;
    setLocked(true);
    return true;
  }, [setLocked]);

  useEffect(() => {
    if (session === "pending") return;
    if (!signedIn) {
      setLocked(false);
      setChecking(false);
      return;
    }
    if (signedOutSinceOpen.current) setChecking(false);
    // The lock screen is up (behind the prompt) before the splash screen goes.
    else
      void lockIfSecured()
        .finally(() => setChecking(false))
        .then((secured) => (secured ? unlock() : undefined));
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") backgroundedAt.current = Date.now();
      if (state === "active") {
        if (shouldRelock(backgroundedAt.current, Date.now()))
          void lockIfSecured().then((secured) => (secured ? unlock() : undefined));
        else if (lockedNow.current && interrupted.current) void unlock();
        backgroundedAt.current = null;
      }
    });
    return () => subscription.remove();
  }, [session, signedIn, setLocked, lockIfSecured, unlock]);

  return { locked, checking, unlock };
}
