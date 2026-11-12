import "server-only";
import { notify } from "@open-bot/db";
import { type AppEvent, NOTIFY_CHANNELS } from "@open-bot/domain";
import { pool } from "./db";

/** Tell open tabs and phones that something app-wide changed (see `APP_EVENT_REFRESHES`). */
export async function publish(event: AppEvent) {
  await notify(pool, NOTIFY_CHANNELS.app, JSON.stringify(event));
}
