import { base, id, ok } from "../base";
import { egressModeSchema, phoneModeSchema, unavailableReasonSchema } from "@open-bot/domain";
import { z } from "zod";

export const egressContract = {
  setMode: base
    .route({ method: "POST", path: "/internal/egress/mode" })
    .input(z.object({ mode: egressModeSchema }))
    .output(ok),
  setPhoneMode: base
    .route({ method: "POST", path: "/internal/egress/phone-mode" })
    .input(z.object({ mode: phoneModeSchema }))
    .output(ok),
  /** Phones were paired, renamed or revoked: read them again. */
  devicesChanged: base
    .route({ method: "POST", path: "/internal/egress/devices/changed" })
    .output(ok),
  /** A phone can't carry traffic right now. Ignored unless `generation` is its pairing now. */
  deviceUnavailable: base
    .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/unavailable" })
    .input(
      z.object({
        deviceId: id,
        reason: unavailableReasonSchema,
        generation: z.number().int().positive(),
        seq: z.number().int().nonnegative().optional(),
      }),
    )
    .output(ok),
  /** Drop a phone's tunnel, unless it was paired again since `generation`. */
  deviceRevoked: base
    .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/revoked" })
    .input(z.object({ deviceId: id, generation: z.number().int().nonnegative() }))
    .output(ok),
  /**
   * Pair a phone, or pair it again with a new secret and generation. The secret is in the answer
   * once; only its hash is kept.
   */
  pairDevice: base
    .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/pair" })
    .input(
      z.object({
        deviceId: id,
        name: z.string().trim().min(1).max(80),
        pushToken: z.string().min(1).max(4096).nullable(),
      }),
    )
    .output(z.object({ secret: z.string(), generation: z.number().int().positive() })),
  /** Unpair a phone; with `generation`, only that pairing. */
  unpairDevice: base
    .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/unpair" })
    .input(z.object({ deviceId: id, generation: z.number().int().positive().optional() }))
    .output(ok),
  /** A paired phone's new FCM token, to wake it with. */
  devicePushToken: base
    .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/push-token" })
    .input(z.object({ deviceId: id, token: z.string().min(1).max(4096) }))
    .output(ok),
  /** A paired phone asked to open the tunnel. */
  deviceUsed: base
    .route({ method: "POST", path: "/internal/egress/devices/{deviceId}/used" })
    .input(z.object({ deviceId: id }))
    .output(ok),
};
