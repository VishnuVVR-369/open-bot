import "server-only";
import { teammates, screenTakeovers, runs } from "@open-bot/db";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/server/db";
import type { TakeoverRequestSummary } from "@/lib/types";

/** Teammates waiting for you to take over their screen, newest first. */
export async function listTakeoverRequests(): Promise<TakeoverRequestSummary[]> {
  const rows = await db
    .select({
      id: screenTakeovers.id,
      screenId: screenTakeovers.screenId,
      teammateId: screenTakeovers.requestedByTeammateId,
      teammateName: teammates.name,
      reason: screenTakeovers.reason,
      chatId: runs.chatId,
      createdAt: screenTakeovers.createdAt,
    })
    .from(screenTakeovers)
    .leftJoin(teammates, eq(teammates.id, screenTakeovers.requestedByTeammateId))
    .leftJoin(runs, eq(runs.id, screenTakeovers.requestedByRunId))
    .where(eq(screenTakeovers.status, "requested"))
    .orderBy(desc(screenTakeovers.createdAt));
  return rows.flatMap((row) => {
    const screenId = row.screenId ?? row.teammateId;
    if (!screenId) return [];
    return [
      {
        id: row.id,
        screenId,
        teammateId: row.teammateId,
        teammateName: row.teammateName ?? "A teammate",
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
      id: screenTakeovers.id,
      screenId: screenTakeovers.screenId,
      startedAt: screenTakeovers.startedAt,
    })
    .from(screenTakeovers)
    .where(eq(screenTakeovers.status, "active"))
    .orderBy(desc(screenTakeovers.createdAt));
}
