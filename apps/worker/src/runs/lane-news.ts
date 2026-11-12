import { runs, schedules, triggers, type Queryable, type RunLane } from "@open-bot/db";
import { and, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";

/** At most this many results are passed on, newest first; older ones are only counted. */
export const LANE_NEWS_LIMIT = 5;
/** Each result is cut to this many characters. The full run stays in the chat. */
export const LANE_NEWS_LENGTH = 1500;

/** What the teammate's other lanes in a chat finished, for its conversation to hear. */
export interface LaneNews {
  /** The note for the conversation's next turn. */
  text: string;
  /** One of the runs read your accounts, so what the conversation does next must ask first. */
  readOutsideData: boolean;
}

interface Finished {
  lane: RunLane;
  status: string;
  finalText: string | null;
  error: string | null;
  completedAt: Date | null;
  readOutsideData: boolean;
  scheduleTitle: string | null;
  triggerTitle: string | null;
}

/**
 * What the teammate's other lanes in this chat (its automations and email) finished since its
 * conversation last took a turn. They run in threads of their own, so the conversation only knows
 * about them from this note, and you may well be replying to one of them.
 */
export async function laneNews(
  db: Queryable,
  run: { id: string; chatId: string; botId: string; lane: RunLane }, // vocabulary: allow
  formatTime: (at: Date) => string,
): Promise<LaneNews | null> {
  if (run.lane !== "chat") return null;
  const teammateId = run.botId; // vocabulary: allow
  const runTeammate = runs.botId; // vocabulary: allow
  // The conversation heard everything that finished before its last turn started. Only a turn
  // Codex began counts: a run that failed before it, say while the computer woke, told it nothing.
  const [previous] = await db
    .select({ at: sql<Date | null>`max(${runs.startedAt})`.mapWith(runs.startedAt) })
    .from(runs)
    .where(
      and(
        eq(runs.chatId, run.chatId),
        eq(runTeammate, teammateId),
        eq(runs.lane, "chat"),
        ne(runs.id, run.id),
        isNotNull(runs.startedAt),
        isNotNull(runs.codexTurnId),
      ),
    );
  const since = previous?.at ?? null;
  // And this turn hears what finished before it started; what finishes after is for the next one.
  const [current] = await db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.id, run.id));
  const until = current?.startedAt ?? null;
  const rows: Finished[] = await db
    .select({
      lane: runs.lane,
      status: runs.status,
      finalText: runs.finalText,
      error: runs.error,
      completedAt: runs.completedAt,
      readOutsideData: runs.readOutsideData,
      scheduleTitle: schedules.title,
      triggerTitle: triggers.title,
    })
    .from(runs)
    .leftJoin(schedules, eq(schedules.id, runs.scheduleId))
    .leftJoin(triggers, eq(triggers.id, runs.triggerId))
    .where(
      and(
        eq(runs.chatId, run.chatId),
        eq(runTeammate, teammateId),
        ne(runs.lane, "chat"),
        inArray(runs.status, ["completed", "failed"]),
        // A quiet routine that found nothing has nothing to pass on.
        eq(runs.quiet, false),
        since ? gt(runs.completedAt, since) : undefined,
        until ? lte(runs.completedAt, until) : undefined,
      ),
    )
    .orderBy(desc(runs.completedAt))
    .limit(LANE_NEWS_LIMIT + 1);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, LANE_NEWS_LIMIT);
  const lines = shown.reverse().map((row) => {
    const when = row.completedAt ? formatTime(row.completedAt) : "earlier";
    const said =
      row.status === "failed"
        ? `It failed: ${row.error ?? "no reason given"}`
        : (row.finalText ?? "(No reply.)");
    return `- ${origin(row)}, ${when}:\n${indent(cut(said))}`;
  });
  if (rows.length > LANE_NEWS_LIMIT)
    lines.unshift("- (More finished before these. They are in this chat's history.)");
  return {
    text: `[While you weren't in this conversation, work you did on your own in this chat finished. The user saw it here and may be replying to it:]\n${lines.join("\n")}`,
    readOutsideData: shown.some((row) => row.readOutsideData),
  };
}

function origin(row: Finished): string {
  if (row.lane === "inbox") return "An email you received";
  if (row.scheduleTitle) return `Your routine "${row.scheduleTitle}"`;
  if (row.triggerTitle) return `Your automation "${row.triggerTitle}"`;
  return "An automation";
}

function cut(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > LANE_NEWS_LENGTH
    ? `${trimmed.slice(0, LANE_NEWS_LENGTH).trimEnd()}… (cut short; the full reply is in the chat)`
    : trimmed;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
