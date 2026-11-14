import { base, id, ok } from "../base";
import { z } from "zod";
import { pushStatusSchema } from "../views";

export const pushContract = {
  /** The key browsers subscribe with, and the browsers subscribed. */
  status: base.route({ method: "GET", path: "/internal/push" }).output(pushStatusSchema),
  subscribe: base
    .route({ method: "POST", path: "/internal/push/subscribe" })
    .input(
      z.object({
        subscription: z.object({
          endpoint: z.string().url().max(2000),
          keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
        }),
        device: z.string().max(200).default(""),
      }),
    )
    .output(ok),
  unsubscribe: base
    .route({ method: "POST", path: "/internal/push/unsubscribe" })
    .input(z.object({ endpoint: z.string() }))
    .output(ok),
  /** Notify every browser and phone; returns how many were sent. */
  test: base
    .route({ method: "POST", path: "/internal/push/test" })
    .output(z.object({ sent: z.number().int().nonnegative() })),
  registerNative: base
    .route({ method: "POST", path: "/internal/push/native/register" })
    .input(
      z.object({
        token: z.string().min(1).max(4096),
        platform: z.literal("android"),
        device: z.string().max(200).default(""),
      }),
    )
    .output(ok),
  unregisterNative: base
    .route({ method: "POST", path: "/internal/push/native/unregister" })
    .input(z.object({ token: z.string().min(1).max(4096) }))
    .output(ok),
};

export const notificationsContract = {
  /** Mark these notifications read, or every one up to `through`, or all of them. */
  markRead: base
    .route({ method: "POST", path: "/internal/notifications/read" })
    .input(z.object({ ids: z.array(id).max(200).optional(), through: id.optional() }))
    .output(ok),
};
