import { notifications, type NotificationKind } from "@open-bot/db";
import type { ApprovalKind } from "@open-bot/domain";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { publishApp, type Context } from "../../context";

/** What open-bot tells you about. Only this module writes `notifications`. */

/** Tell you something: saved for the bell, shown in open tabs, and pushed to your devices. */
export async function createNotification(
  ctx: Pick<Context, "db" | "pool" | "events">,
  input: {
    kind: NotificationKind;
    title: string;
    body?: string;
    botId?: string | null;
    chatId?: string | null;
    runId?: string | null;
    approvalId?: string;
    approvalKind?: ApprovalKind;
    takeoverId?: string;
    pageId?: string | null;
  },
): Promise<void> {
  const [row] = await ctx.db
    .insert(notifications)
    .values({
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      teammateId: input.botId ?? null,
      chatId: input.chatId ?? null,
      runId: input.runId ?? null,
      pageId: input.pageId ?? null,
    })
    .returning({ id: notifications.id });
  await publishApp(ctx, { type: "notification", id: row!.id });
  ctx.events.emit("notification", {
    id: row!.id,
    kind: input.kind,
    title: input.title,
    body: input.body ?? "",
    botId: input.botId ?? null,
    chatId: input.chatId ?? null,
    runId: input.runId ?? null,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    ...(input.approvalKind ? { approvalKind: input.approvalKind } : {}),
    ...(input.takeoverId ? { takeoverId: input.takeoverId } : {}),
    ...(input.pageId ? { pageId: input.pageId } : {}),
  });
}

/**
 * Mark notifications read: these `ids`, or every one up to and including `through`, or all of
 * them when neither is given.
 */
export async function markNotificationsRead(
  ctx: Pick<Context, "db" | "pool">,
  { ids, through }: { ids?: string[]; through?: string },
): Promise<void> {
  // Compared in the database, which keeps the microseconds a timestamp sent back would lose.
  const upTo = through
    ? lte(
        notifications.createdAt,
        ctx.db
          .select({ createdAt: notifications.createdAt })
          .from(notifications)
          .where(eq(notifications.id, through)),
      )
    : undefined;
  await ctx.db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        isNull(notifications.readAt),
        ids?.length ? inArray(notifications.id, ids) : undefined,
        upTo,
      ),
    );
  await publishApp(ctx, { type: "notification" });
}
