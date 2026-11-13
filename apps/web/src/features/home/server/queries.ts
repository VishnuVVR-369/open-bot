import "server-only";
import type { ApiInputs, Home } from "@open-bot/api";
import { chats, runs, schedules, triggers } from "@open-bot/db";
import { isNothingToReport } from "@open-bot/domain";
import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { getAttention } from "@/lib/server/queries";
import type { ActivityView, BriefingItem } from "@/lib/types";

/** Home: what needs you, what you missed since `awaySince`, and what teammates did lately. */
export async function getHome(
  user: { name: string },
  { awaySince }: ApiInputs["home"]["get"],
): Promise<Home> {
  const [attention, briefing, activity] = await Promise.all([
    getAttention(),
    awaySince ? listFinishedSince(new Date(awaySince)) : Promise.resolve([]),
    listActivity(),
  ]);
  return { ...attention, user: { name: user.name }, briefing, activity };
}

/** The latest runs in chats you can see, newest first. */
export async function listActivity(limit = 12): Promise<ActivityView[]> {
  const rows = await db
    .select({ run: runs, chat: chats, prompt: runs.prompt })
    .from(runs)
    .innerJoin(chats, eq(chats.id, runs.chatId))
    .where(and(isNull(chats.archivedAt), ne(chats.kind, "helper")))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows.map(({ run, chat }) => ({
    runId: run.id,
    chatId: chat.id,
    chatKind: chat.kind,
    chatTitle: chat.title,
    botId: run.botId,
    trigger: run.trigger,
    status: run.status,
    preview: run.finalText ?? run.error ?? null,
    createdAt: run.createdAt.toISOString(),
  }));
}

/** Runs that finished since a time, newest first, for the "While you were away" briefing. */
export async function listFinishedSince(since: Date, limit = 60): Promise<BriefingItem[]> {
  const rows = await db
    .select({
      run: runs,
      chat: chats,
      scheduleTitle: schedules.title,
      scheduleQuiet: schedules.quiet,
      triggerTitle: triggers.title,
    })
    .from(runs)
    .innerJoin(chats, eq(chats.id, runs.chatId))
    .leftJoin(schedules, eq(schedules.id, runs.scheduleId))
    .leftJoin(triggers, eq(triggers.id, runs.triggerId))
    .where(
      and(
        isNull(chats.archivedAt),
        ne(chats.kind, "helper"),
        inArray(runs.status, ["completed", "failed"]),
        gte(runs.completedAt, since),
      ),
    )
    .orderBy(desc(runs.completedAt))
    .limit(limit);
  // A quiet routine that found nothing isn't news.
  const news = rows.filter(
    ({ run, scheduleQuiet }) => !(scheduleQuiet && isNothingToReport(run.finalText)),
  );
  return news.map(({ run, chat, scheduleTitle, triggerTitle }) => ({
    runId: run.id,
    chatId: chat.id,
    chatKind: chat.kind,
    chatTitle: chat.title,
    botId: run.botId,
    trigger: run.trigger,
    status: run.status,
    preview: run.finalText ?? run.error ?? null,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt!.toISOString(),
    automationTitle: scheduleTitle ?? triggerTitle ?? null,
  }));
}
