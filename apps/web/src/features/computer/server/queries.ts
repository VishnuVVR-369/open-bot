import "server-only";
import { bots, desktopTakeovers, runs } from "@open-bot/db";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/server/db";
import type { TakeoverRequestSummary } from "@/lib/types";

/** Teammates waiting for you to take over their screen, newest first. */
export async function listTakeoverRequests(): Promise<TakeoverRequestSummary[]> {
  const rows = await db
    .select({
      id: desktopTakeovers.id,
      screenId: desktopTakeovers.screenId,
      botId: desktopTakeovers.requestedByBotId,
      botName: bots.name,
      reason: desktopTakeovers.reason,
      chatId: runs.chatId,
      createdAt: desktopTakeovers.createdAt,
    })
    .from(desktopTakeovers)
    .leftJoin(bots, eq(bots.id, desktopTakeovers.requestedByBotId))
    .leftJoin(runs, eq(runs.id, desktopTakeovers.requestedByRunId))
    .where(eq(desktopTakeovers.status, "requested"))
    .orderBy(desc(desktopTakeovers.createdAt));
  return rows.flatMap((row) => {
    const screenId = row.screenId ?? row.botId;
    if (!screenId) return [];
    return [
      {
        id: row.id,
        screenId,
        botId: row.botId,
        botName: row.botName ?? "A bot",
        reason: row.reason ?? "",
        chatId: row.chatId,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });
}

export function listActiveTakeovers() {
  return db
    .select({
      id: desktopTakeovers.id,
      screenId: desktopTakeovers.screenId,
      startedAt: desktopTakeovers.startedAt,
    })
    .from(desktopTakeovers)
    .where(eq(desktopTakeovers.status, "active"))
    .orderBy(desc(desktopTakeovers.createdAt));
}
