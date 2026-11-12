import type { PhoneMode, UnavailableReason } from "@open-bot/domain";
import { requireNativeModule } from "expo";

export type RunPhase = "off" | "running" | "paused" | "stopped" | "released" | "revoked";

export interface EgressRules {
  /** Only on an unmetered network (Wi-Fi), so traffic never moves to mobile data. */
  wifiOnly: boolean;
  /** Mobile data per calendar month, in bytes; 0 for no limit. */
  monthlyCapBytes: number;
  /** Pause below 20% battery while not charging. */
  lowBatteryPause: boolean;
}

export interface EgressNativeStatus {
  paired: boolean;
  generation: number | null;
  phoneMode: PhoneMode;
  run: { phase: RunPhase; reason: UnavailableReason | null; since: number };
  service: {
    running: boolean;
    connection: "connecting" | "online" | "offline" | null;
    detail: string | null;
    role: "active" | "standby" | "release" | null;
    network: "wifi" | "mobile" | null;
    stats: { openStreams: number; bytesIn: number; bytesOut: number } | null;
  };
  usage: { todayBytes: number; monthBytes: number; monthMeteredBytes: number };
  rules: EgressRules;
}

/**
 * The phone connection (modules/egress): a native service that carries teammates' browsing
 * over this phone. JavaScript pairs and configures it; it runs without JavaScript.
 */
interface NativeEgress {
  /** This install's id, kept across sign-outs. */
  deviceId(): string;
  /** Store the credential from `egress.registerDevice`. It can't be read back. */
  pair(options: {
    secret: string;
    generation: number;
    appUrl: string;
    phoneMode: PhoneMode;
  }): Promise<void>;
  /** Stop the service (waiting for it) and forget the credential. */
  forget(): Promise<void>;
  start(): Promise<void>;
  /** The owner stops it: wakes are ignored for 15 minutes. */
  stop(): Promise<void>;
  status(): EgressNativeStatus;
  setPhoneMode(mode: PhoneMode): Promise<void>;
  setRules(rules: EgressRules): Promise<void>;
  batteryOptimization(): { exempt: boolean; miui: boolean };
  openBatteryOptimizationSettings(): Promise<void>;
  notificationsAllowed(): { permission: boolean; connection: boolean; asking: boolean };
  lowPowerStandby(): { enabled: boolean; exempt: boolean };
  addListener(event: "status", listener: (status: EgressNativeStatus) => void): { remove(): void };
}

export default requireNativeModule<NativeEgress>("OpenBotEgress");
