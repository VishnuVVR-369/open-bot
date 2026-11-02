import "server-only";
import { CHANNELS, notify } from "@open-bot/db";
import { pool } from "./db";

/** Tell open tabs and phones that something app-wide changed. */
export async function publish(type: string) {
  await notify(pool, CHANNELS.app, JSON.stringify({ type }));
}
