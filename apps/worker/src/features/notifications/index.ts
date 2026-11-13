// Notifications: what open-bot tells you about, saved for the bell and pushed to your browsers
// (Web Push) and phones (FCM), and the devices that get them. Code outside this folder imports
// only from here.
export { notificationsFeature } from "./feature";
export { FcmService, nativeEgressPush, type PushResult } from "./fcm";
export { PushService } from "./push";
export { notificationRoutes } from "./routes";
export { createNotification } from "./service";
