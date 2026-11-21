import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect } from "react";
import NativeEgress from "../../modules/egress";
import { api } from "./api";

/**
 * The phone connection's part in signing out and in. The screen that pairs and configures it is
 * the settings feature's (`features/settings/phone-connection.ts`); this is shared infrastructure,
 * since signing out must reach it.
 */

/** A revoke that couldn't reach the server at sign-out, retried after the next sign-in. */
export interface PendingRevoke {
  deviceId: string;
  generation: number;
}

const PENDING_KEY = "openbot:egress-pending-revoke";

/** What signing out needs from the outside world, so the order is tested without a phone. */
export interface SignOutEgressDeps {
  status: () => { paired: boolean; generation: number | null };
  deviceId: () => string;
  /** Stops the service, waiting until it has, and forgets the credential. */
  forget: () => Promise<void>;
  revoke: (revoke: PendingRevoke) => Promise<unknown>;
  remember: (revoke: PendingRevoke) => Promise<void>;
}

/**
 * Before the session ends: stop the service and wait, forget the credential, then revoke this
 * pairing on the server while the session still works. A revoke that fails (offline, or a session
 * that already ended) is remembered and sent after the next sign-in, for this pairing's generation
 * only, so it can never undo a later pairing.
 */
export async function releaseForSignOut(deps: SignOutEgressDeps): Promise<void> {
  const { paired, generation } = deps.status();
  if (!paired || generation === null) {
    await deps.forget();
    return;
  }
  const revoke = { deviceId: deps.deviceId(), generation };
  await deps.forget();
  try {
    await deps.revoke(revoke);
  } catch {
    await deps.remember(revoke);
  }
}

export function releasePhoneConnection(): Promise<void> {
  return releaseForSignOut({
    status: () => NativeEgress.status(),
    deviceId: () => NativeEgress.deviceId(),
    forget: () => NativeEgress.forget(),
    revoke: (revoke) => api.egress.revokeDevice(revoke),
    remember: (revoke) => AsyncStorage.setItem(PENDING_KEY, JSON.stringify(revoke)),
  });
}

/** Reads a remembered revoke; anything malformed is dropped. */
export function parsePendingRevoke(raw: string | null): PendingRevoke | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingRevoke>;
    return typeof value.deviceId === "string" &&
      Number.isInteger(value.generation) &&
      (value.generation ?? 0) > 0
      ? { deviceId: value.deviceId, generation: value.generation! }
      : null;
  } catch {
    return null;
  }
}

/** Send a revoke remembered from an offline sign-out; it stays remembered until one succeeds. */
export async function sendPendingRevoke(): Promise<void> {
  const pending = parsePendingRevoke(await AsyncStorage.getItem(PENDING_KEY));
  if (!pending) {
    await AsyncStorage.removeItem(PENDING_KEY);
    return;
  }
  await api.egress.revokeDevice(pending);
  await AsyncStorage.removeItem(PENDING_KEY);
}

/** Once signed in, send any revoke an offline sign-out left behind. */
export function usePendingRevoke(signedIn: boolean) {
  useEffect(() => {
    if (signedIn) void sendPendingRevoke().catch(() => {});
  }, [signedIn]);
}
