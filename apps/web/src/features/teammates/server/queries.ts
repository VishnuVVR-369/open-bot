import "server-only";
import { teammates, chats, runs } from "@open-bot/db";
import { ACTIVE_RUN_STATUSES } from "@open-bot/domain";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import type { TeammateSummary } from "@/lib/types";

export async function listTeammates(): Promise<TeammateSummary[]> {
  const rows = await db
    .select()
    .from(teammates)
    .where(isNull(teammates.archivedAt))
    .orderBy(asc(teammates.createdAt));
  // Each teammate's main chat. One whose main chat isn't marked, because a worker from before main
  // chats added or archived it, shows its most recently active open direct chat: the one the
  // worker hands the role to when work arrives.
  const chatTeammate = chats.teammateId;
  const mainChats = await db
    .selectDistinctOn([chatTeammate], { id: chats.id, teammateId: chatTeammate })
    .from(chats)
    .where(and(eq(chats.kind, "direct"), isNull(chats.archivedAt)))
    .orderBy(chatTeammate, desc(chats.main), desc(chats.lastActivityAt), desc(chats.createdAt));
  const active = await db
    .select({
      id: runs.id,
      teammateId: runs.teammateId,
      chatId: runs.chatId,
      status: runs.status,
      waitingFor: runs.waitingFor,
    })
    .from(runs)
    .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES]))
    .orderBy(desc(runs.createdAt));
  // Each teammate's newest run, read through runs_bot_idx: when it finished, or when it began.
  const latest = await db
    .selectDistinctOn([runs.teammateId], {
      teammateId: runs.teammateId,
      at: sql<Date>`coalesce(${runs.completedAt}, ${runs.startedAt}, ${runs.createdAt})`.mapWith(
        runs.createdAt,
      ),
    })
    .from(runs)
    .orderBy(runs.teammateId, desc(runs.createdAt));
  return rows.map((teammate) => {
    const run =
      active.find((r) => r.teammateId === teammate.id && r.status !== "queued") ??
      active.find((r) => r.teammateId === teammate.id);
    return {
      id: teammate.id,
      name: teammate.name,
      slug: teammate.slug,
      role: teammate.role,
      color: teammate.color,
      emoji: teammate.emoji,
      autonomy: teammate.autonomy,
      isLead: teammate.isLead,
      directChatId: mainChats.find((chat) => chat.teammateId === teammate.id)?.id ?? null,
      lastActiveAt:
        latest.find((entry) => entry.teammateId === teammate.id)?.at.toISOString() ?? null,
      activeRun: run
        ? { id: run.id, chatId: run.chatId, status: run.status, waitingFor: run.waitingFor ?? null }
        : null,
    };
  });
}
