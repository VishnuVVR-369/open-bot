import { eq } from "drizzle-orm";
import type { Queryable } from "./index";
import { settings } from "./schema";

/**
 * The owner's settings are one row. Read them only through these, so a missing row means the same
 * defaults everywhere. The worker writes the row (packages/db/src/owners.ts).
 */
export const SETTINGS_ID = 1;

/** Times are shown and scheduled in UTC until the owner's browser reports their time zone. */
export const DEFAULT_TIME_ZONE = "UTC";

export type OwnerSettings = typeof settings.$inferSelect;

/** The settings row, or null before the worker first starts. */
export async function ownerSettings(db: Queryable): Promise<OwnerSettings | null> {
  const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID));
  return row ?? null;
}

/** The owner's time zone, for schedules, prompts and anything shown as a local time. */
export async function ownerTimeZone(db: Queryable): Promise<string> {
  const [row] = await db
    .select({ timezone: settings.timezone })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID));
  return row?.timezone ?? DEFAULT_TIME_ZONE;
}
