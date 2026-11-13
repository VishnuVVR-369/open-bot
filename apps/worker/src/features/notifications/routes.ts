import type { Context } from "../../context";
import { os } from "../../core/rpc";
import type { FcmService } from "./fcm";
import type { PushService } from "./push";
import { markNotificationsRead } from "./service";

const ok = { ok: true } as const;

/**
 * Your devices that get notifications, browsers and phones, and marking notifications read, as the
 * web app asks (`workerContract.push` and `.notifications`).
 */
export function notificationRoutes(
  ctx: Pick<Context, "db" | "pool">,
  push: PushService,
  fcm: FcmService,
) {
  return {
    push: {
      status: os.push.status.handler(async () => ({
        publicKey: await push.publicKey(),
        devices: (await push.devices()).map((row) => ({
          endpoint: row.endpoint,
          device: row.device,
          createdAt: row.createdAt.toISOString(),
        })),
      })),
      subscribe: os.push.subscribe.handler(async ({ input }) => {
        await push.subscribe(input.subscription, input.device);
        return ok;
      }),
      unsubscribe: os.push.unsubscribe.handler(async ({ input }) => {
        await push.unsubscribe(input.endpoint);
        return ok;
      }),
      test: os.push.test.handler(async () => {
        const [browsers, phones] = await Promise.all([
          push.sendAll({
            title: "open-bot",
            body: "Notifications work on this device.",
            url: "/settings#notifications",
            tag: "push-test",
          }),
          fcm.sendAll({
            data: {
              type: "notification",
              kind: "test",
              title: "open-bot",
              body: "Notifications work on this phone.",
              tag: "push-test",
              url: "/",
            },
            priority: "normal",
          }),
        ]);
        return { sent: browsers + phones };
      }),
      registerNative: os.push.registerNative.handler(async ({ input }) => {
        await fcm.register(input);
        return ok;
      }),
      unregisterNative: os.push.unregisterNative.handler(async ({ input }) => {
        await fcm.unregister(input.token);
        return ok;
      }),
    },
    notifications: {
      markRead: os.notifications.markRead.handler(async ({ input }) => {
        await markNotificationsRead(ctx, input);
        return ok;
      }),
    },
  };
}
