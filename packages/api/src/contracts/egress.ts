import { egressModeSchema, phoneModeSchema } from "@open-bot/domain";
import { z } from "zod";
import { base, id, ok } from "../base";
import { egressDeviceViewSchema, egressStatusSchema } from "../egress";

export const egressContract = {
  /** Where the computer's browser traffic goes now, and each device's state. */
  status: base.output(egressStatusSchema),
  setMode: base.input(z.object({ mode: egressModeSchema })).output(ok),
  setPhoneMode: base.input(z.object({ mode: phoneModeSchema })).output(ok),
  /** Phones paired to carry the traffic. */
  devices: base.output(z.array(egressDeviceViewSchema)),
  /**
   * Pair this phone, or pair it again. Returns its new secret, once; the phone's native code
   * keeps it. Pairing again rotates the secret and makes the old one useless.
   */
  registerDevice: base
    .input(
      z.object({
        deviceId: id,
        name: z.string().trim().min(1).max(80),
        /** The phone's FCM token, for waking it; null without push notifications. */
        pushToken: z.string().min(1).max(4096).nullable(),
      }),
    )
    .output(z.object({ secret: z.string(), generation: z.number().int().positive() })),
  /**
   * Unpair a phone. With `generation`, only that pairing is revoked, so a revoke delayed from an
   * offline sign-out can't undo a later pairing.
   */
  revokeDevice: base
    .input(z.object({ deviceId: id, generation: z.number().int().positive().optional() }))
    .output(ok),
};
