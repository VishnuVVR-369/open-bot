import type { EgressDeviceView, EgressStatusView } from "@open-bot/api";
import type { PhoneMode, UnavailableReason } from "@open-bot/domain";
import type { EgressNativeStatus } from "../../../modules/egress";

/**
 * The phone connection, as the settings screen shows and changes it: what this phone is doing in
 * words, pairing in the right order, and turning it off. Platform-free, so it's tested in Node.
 */

/** Monthly mobile data limits to pick from, in bytes (decimal, as carriers count). */
export const CAP_CHOICES: { bytes: number; label: string }[] = [
  { bytes: 500e6, label: "500 MB" },
  { bytes: 1e9, label: "1 GB" },
  { bytes: 2e9, label: "2 GB" },
  { bytes: 5e9, label: "5 GB" },
  { bytes: 10e9, label: "10 GB" },
  { bytes: 0, label: "No limit" },
];

export function capLabel(bytes: number): string {
  return (
    CAP_CHOICES.find((choice) => choice.bytes === bytes)?.label ??
    `${Math.round(bytes / 1e8) / 10} GB`
  );
}

/** Why this phone paused, said about this phone. */
export const PAUSE_REASONS: Record<UnavailableReason, string> = {
  "wifi-only": "This phone is on mobile data, and Wi-Fi only is on.",
  "data-cap": "This month's mobile data limit is reached.",
  "low-battery": "The battery is low. It goes on once the phone charges.",
  "low-power-standby": "Low Power Standby is on, so Android cuts the connection.",
  stopped: "You stopped it.",
};

export type PhoneTone = "active" | "idle" | "attention" | "off";

export interface PhoneState {
  label: string;
  detail: string | null;
  tone: PhoneTone;
}

/** What this phone's connection is doing right now, in a few words and a line about it. */
export function phoneState(native: EgressNativeStatus): PhoneState {
  const { run, service, phoneMode } = native;
  if (!native.paired)
    return run.phase === "revoked"
      ? {
          label: "Turned off",
          detail: "This phone was removed from the web or another device.",
          tone: "attention",
        }
      : { label: "Off", detail: null, tone: "off" };
  if (run.phase === "paused")
    return {
      label: "Paused",
      detail: run.reason ? PAUSE_REASONS[run.reason] : null,
      tone: "attention",
    };
  if (service.running) {
    if (service.role === "release") return { label: "Stopping", detail: null, tone: "idle" };
    if (service.connection === "online" && service.role === "standby")
      return {
        label: "Standing by",
        detail: "Your Mac carries the traffic. This phone finishes what it started.",
        tone: "idle",
      };
    if (service.connection === "online")
      return {
        label: "Carrying teammates' browsing",
        detail:
          service.network === "mobile"
            ? "On mobile data"
            : service.network === "wifi"
              ? "On Wi-Fi"
              : null,
        tone: "active",
      };
    return { label: "Connecting", detail: service.detail, tone: "idle" };
  }
  if (run.phase === "stopped")
    return {
      label: "Stopped by you",
      detail:
        phoneMode === "always"
          ? "It stays off until you start it again."
          : "Teammates can wake it again in 15 minutes, or start it now.",
      tone: "off",
    };
  if (phoneMode === "off")
    return {
      label: "Not in use",
      detail: "Phones never carry traffic. Choose when this one should below.",
      tone: "off",
    };
  if (phoneMode === "always")
    return { label: "Not running", detail: "Start it to carry traffic again.", tone: "attention" };
  return {
    label: "Ready",
    detail: "It starts on its own when teammates browse and your Mac is offline.",
    tone: "idle",
  };
}

/** Whether Android's notifications for the phone connection would be seen. */
export interface NotificationAccess {
  permission: boolean;
  connection: boolean;
}

/**
 * What stops the owner from seeing the phone connection's notices ("Tap to start", pauses), or
 * null. A blocked channel matters as much as the permission: Android hides both silently.
 */
export function notificationProblem(access: NotificationAccess): "permission" | "channel" | null {
  if (!access.permission) return "permission";
  if (!access.connection) return "channel";
  return null;
}

export interface PairDeps {
  /** Asks for the notification permission if needed, then says what is allowed. */
  notifications: () => Promise<NotificationAccess>;
  deviceId: () => string;
  deviceName: () => string;
  pushToken: () => Promise<string | null>;
  /** The phone mode on the server now. */
  serverPhoneMode: PhoneMode;
  register: (input: {
    deviceId: string;
    name: string;
    pushToken: string | null;
  }) => Promise<{ secret: string; generation: number }>;
  setServerPhoneMode: (mode: PhoneMode) => Promise<unknown>;
  pair: (options: { secret: string; generation: number; phoneMode: PhoneMode }) => Promise<void>;
  /**
   * Stops the service and forgets the credential, only if the phone still holds this generation's:
   * a pairing made meanwhile is never undone by an older one's rollback.
   */
  forgetIfMine: (generation: number) => Promise<unknown>;
  /** The server has made this pairing (for `removedOnServer`). */
  onRegistered: () => void;
  /** Revokes a pairing now, or remembers to once the server can be reached. */
  revokeOrRemember: (input: { deviceId: string; generation: number }) => Promise<unknown>;
  /** False once a sign-out began or ended since pairing began, or while one runs. */
  stillSignedIn: () => boolean;
}

export type PairResult =
  { ok: true } | { ok: false; problem: "permission" | "channel" | "signed-out" };

/**
 * Pair this phone: notifications first (without them "Tap to start" and pause notices would be
 * invisible), then the server makes a credential, the native side keeps it, and the phone mode
 * becomes `fallback` if phones were off. Anything that fails after the server made the credential
 * undoes the pairing on both sides, so the server never lists a phone that can't connect. A
 * sign-out while pairing wins: the credential mustn't outlive the session that made it.
 */
export async function pairPhone(deps: PairDeps): Promise<PairResult> {
  const problem = notificationProblem(await deps.notifications());
  if (problem) return { ok: false, problem };
  if (!deps.stillSignedIn()) return { ok: false, problem: "signed-out" };
  const deviceId = deps.deviceId();
  const { secret, generation } = await deps.register({
    deviceId,
    name: deps.deviceName(),
    pushToken: await deps.pushToken().catch(() => null),
  });
  deps.onRegistered();
  const revoke = () => deps.revokeOrRemember({ deviceId, generation });
  const undo = async () => {
    await deps.forgetIfMine(generation).catch(() => {});
    await revoke();
  };
  // Nothing is on the phone yet: only the server has to forget it.
  if (!deps.stillSignedIn()) {
    await revoke();
    return { ok: false, problem: "signed-out" };
  }
  const phoneMode = deps.serverPhoneMode === "off" ? "fallback" : deps.serverPhoneMode;
  try {
    await deps.pair({ secret, generation, phoneMode });
    if (phoneMode !== deps.serverPhoneMode) await deps.setServerPhoneMode(phoneMode);
  } catch (error) {
    await undo();
    throw error;
  }
  if (!deps.stillSignedIn()) {
    await undo();
    return { ok: false, problem: "signed-out" };
  }
  return { ok: true };
}

/**
 * "Turn off for this phone": the service stops and the credential goes first, so nothing keeps
 * running if the server can't be reached; then the server forgets this pairing, now or, if it
 * can't be reached, once it can.
 */
export async function turnOffThisPhone(deps: {
  status: () => { generation: number | null };
  deviceId: () => string;
  forget: () => Promise<unknown>;
  revokeOrRemember: (input: {
    deviceId: string;
    generation: number;
  }) => Promise<"sent" | "remembered">;
}): Promise<"sent" | "remembered" | null> {
  const { generation } = deps.status();
  const deviceId = deps.deviceId();
  await deps.forget();
  return generation === null ? null : deps.revokeOrRemember({ deviceId, generation });
}

/**
 * The server no longer lists this phone (removed from the web or another phone) though it still
 * holds a credential. Only a list whose request started after this pairing was registered counts,
 * so a slow answer from before the pairing never unpairs it. `registeredAt` is 0 for a pairing
 * made before the app started, which every list read since is newer than.
 */
export function removedOnServer(
  devices: { list: Pick<EgressDeviceView, "id">[]; startedAt: number } | undefined,
  deviceId: string,
  paired: boolean,
  registeredAt: number,
): boolean {
  return Boolean(
    paired &&
    devices &&
    devices.startedAt > registeredAt &&
    !devices.list.some((device) => device.id === deviceId),
  );
}

/** When this app last registered a pairing, for `removedOnServer`. */
let lastRegisteredAt = 0;
export const registeredAt = () => lastRegisteredAt;
export function noteRegistered(now = Date.now()) {
  lastRegisteredAt = now;
}

/**
 * Show the battery notice when the server saw this phone miss a wake and Android may still be
 * holding it back (it isn't exempt from battery optimization).
 */
export function needsBatteryHelp(
  status: EgressStatusView | undefined,
  deviceId: string,
  battery: { exempt: boolean },
): boolean {
  if (battery.exempt) return false;
  const phone = status?.phones.find((entry) => entry.id === deviceId);
  return Boolean(phone?.unanswered && !phone.online);
}

/** "Used 5m ago", "Never used", for a paired phone's row. */
export function lastUsedLabel(
  device: Pick<EgressDeviceView, "lastUsedAt" | "online">,
  ago: (iso: string) => string,
): string {
  if (device.online) return "Connected now";
  return device.lastUsedAt ? `Last used ${ago(device.lastUsedAt)}` : "Never used";
}
