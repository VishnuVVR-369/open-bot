import "server-only";
import { os } from "@/lib/server/api/rpc";
import { listNotifications } from "./queries";
import { markNotificationsRead } from "./service";

export function notificationRoutes() {
  return {
    list: os.notifications.list.handler(() => listNotifications()),
    markRead: os.notifications.markRead.handler(({ input }) => markNotificationsRead(input)),
  };
}
