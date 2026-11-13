import "server-only";
import { notifications } from "@open-bot/db";
import { desc } from "drizzle-orm";
import type { NotificationView } from "@/lib/types";
import { db } from "@/lib/server/db";

export async function listNotifications(limit = 40): Promise<NotificationView[]> {
  const rows = await db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    botId: row.botId,
    chatId: row.chatId,
    runId: row.runId,
    pageId: row.pageId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
