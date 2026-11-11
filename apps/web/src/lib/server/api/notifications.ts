import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { worker } from "../worker";

/** The worker marks them read (it owns notifications, see packages/db/src/owners.ts). */
export async function markNotificationsRead(input: ApiInputs["notifications"]["markRead"]) {
  return worker.notifications.markRead(input);
}
