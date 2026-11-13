import { z } from "zod";
import { base, ok } from "../base";
import { pushStatusSchema } from "../worker/views";

export const pushContract = {
  /** The key browsers subscribe with, and the browsers subscribed. */
  status: base.output(pushStatusSchema),
  /** Send notifications to this phone, by its Firebase Cloud Messaging token. */
  registerDevice: base
    .input(
      z.object({
        token: z.string().min(1).max(4096),
        platform: z.literal("android"),
        /** The device, in words, like "Pixel 9". */
        device: z.string().max(200),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  unregisterDevice: base
    .input(z.object({ token: z.string().min(1).max(4096) }))
    .output(z.object({ ok: z.literal(true) })),
  /** Send a test notification to every device. */
  test: base.output(z.object({ sent: z.number().int().nonnegative() })),
  /** Send notifications to this browser, by its Web Push subscription. */
  subscribe: base
    .input(
      z.object({
        subscription: z.object({
          endpoint: z.string().url().max(2000),
          keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
        }),
        /** The browser, in words, like "Chrome on Mac". */
        device: z.string().max(200),
      }),
    )
    .output(ok),
  unsubscribe: base.input(z.object({ endpoint: z.string().max(2000) })).output(ok),
};
