import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { notifications } from "@open-bot/db";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { publish } from "../publish";

export async function markNotificationsRead({
  ids,
  through,
}: ApiInputs["notifications"]["markRead"]) {
  // Compared in the database, which keeps the microseconds a timestamp sent back would lose.
  const upTo = through
    ? lte(
        notifications.createdAt,
        db
          .select({ createdAt: notifications.createdAt })
          .from(notifications)
          .where(eq(notifications.id, through)),
      )
    : undefined;
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        isNull(notifications.readAt),
        ids?.length ? inArray(notifications.id, ids) : undefined,
        upTo,
      ),
    );
  await publish("notification");
  return { ok: true as const };
}
