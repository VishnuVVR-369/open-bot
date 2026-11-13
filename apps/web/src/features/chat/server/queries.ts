import "server-only";
import {
  chats,
  messages,
  runEvents,
  runs,
  schedules,
  swarms,
  swarmTasks,
  triggers,
  usageEntries,
} from "@open-bot/db";
import {
  ACCOUNT_TRIGGER_NOTE,
  applyRunEvent,
  emptyTimeline,
  hideOutsideDataNote,
  PAGE_TEXT_NOTE,
  type RunStatus,
  WEBHOOK_PAYLOAD_NOTE,
} from "@open-bot/domain";
import { and, asc, desc, eq, ilike, inArray, isNull, lt, max, ne, sql } from "drizzle-orm";
import { toMessageView } from "@open-bot/api";
import type { ChatData, ChatEntry, RunView, SearchResultView } from "@/lib/types";
import { db } from "@/lib/server/db";
import { listTeammates } from "@/features/teammates/server";
import { listChats } from "./lists";
import { plainText } from "@/lib/utils";

const PAGE = 30;

export async function getChatData(chatId: string, before?: string): Promise<ChatData | null> {
  const chatList = await listChats({ helpers: true, previews: false });
  const chat = chatList.find((entry) => entry.id === chatId);
  if (!chat) return null;
  const helper = chat.kind === "helper" ? await helperOf(chatId) : null;
  const allBots = await listTeammates();
  const members = allBots.filter((teammate) => chat.memberIds.includes(teammate.id));
  const beforeDate = before ? new Date(before) : null;

  const [allMessageRows, allRunRows] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          beforeDate ? lt(messages.createdAt, beforeDate) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(PAGE),
    db
      .select({ run: runs, scheduleTitle: schedules.title, triggerTitle: triggers.title })
      .from(runs)
      .leftJoin(schedules, eq(schedules.id, runs.scheduleId))
      .leftJoin(triggers, eq(triggers.id, runs.triggerId))
      .where(and(eq(runs.chatId, chatId), beforeDate ? lt(runs.createdAt, beforeDate) : undefined))
      .orderBy(desc(runs.createdAt))
      .limit(PAGE),
  ]);
  // Messages and runs are paged separately, so a full page of one can reach further back than
  // the other. Stop both at the later of their cutoffs, so the next page (before that) has no gap.
  const cutoffs = [
    allMessageRows.length === PAGE ? allMessageRows.at(-1)!.createdAt.getTime() : null,
    allRunRows.length === PAGE ? allRunRows.at(-1)!.run.createdAt.getTime() : null,
  ].filter((value): value is number => value !== null);
  const cutoff = cutoffs.length ? Math.max(...cutoffs) : null;
  const messageRows =
    cutoff === null
      ? allMessageRows
      : allMessageRows.filter((row) => row.createdAt.getTime() >= cutoff);
  const runRows =
    cutoff === null
      ? allRunRows
      : allRunRows.filter((row) => row.run.createdAt.getTime() >= cutoff);

  const runIds = runRows.map((row) => row.run.id);
  const events = runIds.length
    ? await db
        .select({ id: runEvents.id, runId: runEvents.runId, payload: runEvents.payload })
        .from(runEvents)
        .where(inArray(runEvents.runId, runIds))
        .orderBy(asc(runEvents.id))
    : [];
  const usage = await usageByRun(runIds);
  const [cursorRow] = await db
    .select({ value: max(runEvents.id) })
    .from(runEvents)
    .where(eq(runEvents.chatId, chatId));

  const parentIds = runRows
    .map((row) => row.run.parentRunId)
    .filter((id): id is string => Boolean(id));
  const parents = parentIds.length
    ? await db
        .select({ id: runs.id, botId: runs.botId })
        .from(runs)
        .where(inArray(runs.id, parentIds))
    : [];

  const runViews: RunView[] = runRows.map(({ run, scheduleTitle, triggerTitle }) => {
    let timeline = emptyTimeline(run.status as RunStatus);
    for (const event of events)
      if (event.runId === run.id) timeline = applyRunEvent(timeline, event.payload);
    // The row is the source of truth for status, in case an event was lost.
    timeline = { ...timeline, status: run.status, error: run.error ?? timeline.error };
    return {
      id: run.id,
      botId: run.botId,
      trigger: run.trigger,
      messageId: run.messageId,
      parentRunId: run.parentRunId,
      authMode: run.authMode ?? null,
      fromBotId:
        run.trigger === "handoff" || run.trigger === "question" || run.trigger === "answer"
          ? (parents.find((p) => p.id === run.parentRunId)?.botId ?? null)
          : null,
      scheduleTitle,
      triggerTitle,
      automationPrompt: automationPrompt(run),
      rating: run.rating ?? null,
      usage: usage.get(run.id) ?? null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      timeline,
    };
  });

  const entries: ChatEntry[] = [
    ...messageRows.map((row) => ({
      type: "message" as const,
      at: row.createdAt.toISOString(),
      message: toMessageView(row),
    })),
    ...runViews.map((run) => ({ type: "run" as const, at: run.createdAt, run })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return {
    chat,
    members,
    entries,
    cursor: Number(cursorRow?.value ?? 0),
    hasMore: cutoff !== null,
    helper,
  };
}

/** For a swarm helper's chat: its screen, and the swarm it's part of. */
async function helperOf(chatId: string): Promise<ChatData["helper"]> {
  const [row] = await db
    .select({ task: swarmTasks, swarm: swarms })
    .from(swarmTasks)
    .innerJoin(swarms, eq(swarms.id, swarmTasks.swarmId))
    .where(eq(swarmTasks.chatId, chatId));
  if (!row) return null;
  return {
    screenId: row.task.id,
    state: row.task.status,
    swarmTitle: row.swarm.title,
    swarmChatId: row.swarm.chatId,
    swarmRunId: row.swarm.runId,
  };
}

/** Tokens and cost per run, from the usage ledger. */
async function usageByRun(
  runIds: string[],
): Promise<Map<string, { tokens: number; costMicros: number }>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({
      runId: usageEntries.runId,
      tokens: sql<string>`sum(${usageEntries.inputTokens} + ${usageEntries.outputTokens})`,
      costMicros: sql<string>`sum(${usageEntries.costMicros})`,
    })
    .from(usageEntries)
    .where(inArray(usageEntries.runId, runIds))
    .groupBy(usageEntries.runId);
  return new Map(
    rows.map((row) => [
      row.runId!,
      { tokens: Number(row.tokens), costMicros: Number(row.costMicros) },
    ]),
  );
}

/** What an automation gave the teammate, without the header line naming the automation. */
function automationPrompt(run: { trigger: string; prompt: string }): string | null {
  if (!["schedule", "watch", "webhook", "gmail", "calendar"].includes(run.trigger)) return null;
  // The warnings about outside text are for the teammate, not for you.
  return hideOutsideDataNote(
    run.prompt
      .replace(/^\[(Scheduled task|Watch|Webhook|Gmail|Calendar): "[^\n]*"\]\n+/, "")
      .replace(WEBHOOK_PAYLOAD_NOTE, "It received:")
      .replace(` ${PAGE_TEXT_NOTE}`, "")
      .replace(` ${ACCOUNT_TRIGGER_NOTE}`, ""),
  );
}

/** The text around the first match, on one line, so a result shows why it matched. */
export function excerptAround(text: string, query: string, radius = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/** Your messages and teammates' replies that contain the query, newest first. */
export async function searchMessages(query: string, limit = 12): Promise<SearchResultView[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [mine, replies] = await Promise.all([
    db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        text: messages.text,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(
        and(eq(messages.role, "user"), ilike(messages.text, pattern), isNull(chats.archivedAt)),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit),
    db
      .select({
        id: runs.id,
        chatId: runs.chatId,
        botId: runs.botId,
        text: runs.finalText,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .innerJoin(chats, eq(chats.id, runs.chatId))
      .where(
        and(ilike(runs.finalText, pattern), isNull(chats.archivedAt), ne(chats.kind, "helper")),
      )
      .orderBy(desc(runs.createdAt))
      .limit(limit),
  ]);
  return [
    ...mine.map((row) => ({
      id: row.id,
      from: "you" as const,
      chatId: row.chatId,
      runId: null,
      botId: null,
      excerpt: excerptAround(row.text, q),
      createdAt: row.createdAt.toISOString(),
    })),
    ...replies.map((row) => ({
      id: row.id,
      from: "bot" as const,
      chatId: row.chatId,
      runId: row.id,
      botId: row.botId,
      excerpt: excerptAround(plainText(row.text ?? ""), q),
      createdAt: row.createdAt.toISOString(),
    })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
