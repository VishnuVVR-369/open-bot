import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect } from "react";
import NativeEgress from "../../modules/egress";
import { api } from "./api";

/**
 * The phone connection's part in signing out and in, and the revokes that couldn't reach the
 * server. The screen that pairs and configures it is the settings feature's
 * (`features/settings/phone-connection.ts`); this is shared infrastructure, since signing out
 * must reach it.
 */

/** A revoke that couldn't reach the server, sent again later. */
export interface PendingRevoke {
  deviceId: string;
  generation: number;
}

const PENDING_KEY = "openbot:egress-pending-revokes";

/**
 * Counts sign-outs, so a pairing that started before one can tell it must not finish: its
 * credential would outlive the session that made it.
 */
let signOuts = 0;
export const signOutCount = () => signOuts;

/** Reads the remembered revokes; anything malformed is dropped. */
export function parsePendingRevokes(raw: string | null): PendingRevoke[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return (Array.isArray(value) ? value : []).filter(
      (entry: Partial<PendingRevoke> | null): entry is PendingRevoke =>
        typeof entry?.deviceId === "string" &&
        Number.isInteger(entry.generation) &&
        (entry.generation ?? 0) > 0,
    );
  } catch {
    return [];
  }
}

const same = (a: PendingRevoke, b: PendingRevoke) =>
  a.deviceId === b.deviceId && a.generation === b.generation;

/** Storage for remembered revokes, so the queue is tested without a phone. */
export interface RevokeStore {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
}

const store: RevokeStore = {
  read: () => AsyncStorage.getItem(PENDING_KEY),
  write: (value) => AsyncStorage.setItem(PENDING_KEY, value),
};

/** Writes go one at a time, so two changes never overwrite each other. */
let queue: Promise<unknown> = Promise.resolve();
function update(
  change: (current: PendingRevoke[]) => PendingRevoke[],
  storage: RevokeStore,
): Promise<void> {
  const next = queue.then(async () => {
    const current = parsePendingRevokes(await storage.read());
    await storage.write(JSON.stringify(change(current)));
  });
  queue = next.catch(() => {});
  return next;
}

/** Remember a revoke to send later; each pairing's generation is kept on its own. */
export function rememberRevoke(revoke: PendingRevoke, storage = store): Promise<void> {
  return update((current) => [...current.filter((entry) => !same(entry, revoke)), revoke], storage);
}

/**
 * Send every remembered revoke. Each is forgotten only once it was sent, and only that one, so a
 * revoke remembered meanwhile (a later sign-out's) stays. The server revokes a pairing only for
 * its generation, so an old revoke never undoes a later pairing.
 */
export async function sendPendingRevokes(
  revoke: (revoke: PendingRevoke) => Promise<unknown> = (input) => api.egress.revokeDevice(input),
  storage = store,
): Promise<void> {
  const pending = parsePendingRevokes(await storage.read());
  for (const entry of pending) {
    try {
      await revoke(entry);
    } catch {
      continue;
    }
    await update((current) => current.filter((other) => !same(other, entry)), storage);
  }
}

/** Revoke a pairing now, or remember to when the server can be reached. */
export async function revokeOrRemember(
  revoke: PendingRevoke,
  send: (revoke: PendingRevoke) => Promise<unknown> = (input) => api.egress.revokeDevice(input),
  storage = store,
): Promise<"sent" | "remembered"> {
  try {
    await send(revoke);
    return "sent";
  } catch {
    await rememberRevoke(revoke, storage);
    return "remembered";
  }
}

/** What signing out needs from the outside world, so the order is tested without a phone. */
export interface SignOutEgressDeps {
  status: () => { paired: boolean; generation: number | null };
  deviceId: () => string;
  /** Stops the service, waiting until it has, and forgets the credential. */
  forget: () => Promise<void>;
  revokeOrRemember: (revoke: PendingRevoke) => Promise<unknown>;
}

/**
 * Before the session ends: stop the service and wait, forget the credential, then revoke this
 * pairing on the server while the session still works. A revoke that fails (offline, or a session
 * that already ended) is remembered and sent after the next sign-in, for this pairing's generation
 * only, so it can never undo a later pairing.
 */
export async function releaseForSignOut(deps: SignOutEgressDeps): Promise<void> {
  signOuts += 1;
  const { paired, generation } = deps.status();
  const revoke = paired && generation !== null ? { deviceId: deps.deviceId(), generation } : null;
  await deps.forget();
  if (revoke) await deps.revokeOrRemember(revoke);
}

export function releasePhoneConnection(): Promise<void> {
  return releaseForSignOut({
    status: () => NativeEgress.status(),
    deviceId: () => NativeEgress.deviceId(),
    forget: () => NativeEgress.forget(),
    revokeOrRemember: (revoke) => revokeOrRemember(revoke),
  });
}

/** Once signed in (and whenever the app starts signed in), send revokes left from before. */
export function usePendingRevokes(signedIn: boolean) {
  useEffect(() => {
    if (signedIn) void sendPendingRevokes().catch(() => {});
  }, [signedIn]);
}
