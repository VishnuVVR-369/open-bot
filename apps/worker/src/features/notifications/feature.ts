import type { Feature } from "../../core/feature";
import type { Startable } from "../../core/runtime";

/** Notifications' background work: pushing each new one to your browsers and to your phones. */
export function notificationsFeature(services: { push: Startable; fcm: Startable }): Feature {
  return {
    name: "notifications",
    async start(runtime) {
      await runtime.start("web push", services.push);
      await runtime.start("phone notifications", services.fcm);
    },
    signals: {},
  };
}
