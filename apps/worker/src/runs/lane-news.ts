import { runs, schedules, triggers, type Queryable, type RunLane } from "@open-bot/db";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";

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
  /** Every run it covers, to mark passed on once Codex has the turn (`markPassedOn`). */
  runIds: string[];
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
 * What the teammate's other lanes in this chat (its automations and email) finished that its
 * conversation hasn't heard yet. They run in threads of their own, so the conversation only knows
 * about them from this note, and you may well be replying to one of them.
 *
 * Each result is marked when a turn that carried it begins, rather than inferred from times: a
 * result whose completion is saved late, or a turn that fails before reaching Codex, would
 * otherwise be skipped or told twice.
 */
export async function laneNews(
  db: Queryable,
  run: { chatId: string; botId: string; lane: RunLane }, // vocabulary: allow
  formatTime: (at: Date) => string,
): Promise<LaneNews | null> {
  if (run.lane !== "chat") return null;
  const teammateId = run.botId; // vocabulary: allow
  const runTeammate = runs.botId; // vocabulary: allow
  const unheard = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.chatId, run.chatId),
        eq(runTeammate, teammateId),
        ne(runs.lane, "chat"),
        inArray(runs.status, ["completed", "failed"]),
        // A quiet routine that found nothing has nothing to pass on.
        eq(runs.quiet, false),
        isNull(runs.passedOnAt),
      ),
    )
    .orderBy(desc(runs.completedAt), desc(runs.id));
  if (unheard.length === 0) return null;
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
      inArray(
        runs.id,
        unheard.slice(0, LANE_NEWS_LIMIT).map((row) => row.id),
      ),
    )
    .orderBy(asc(runs.completedAt), asc(runs.id));
  const lines = rows.map((row) => {
    const when = row.completedAt ? formatTime(row.completedAt) : "earlier";
    const said =
      row.status === "failed"
        ? `It failed: ${row.error ?? "no reason given"}`
        : (row.finalText ?? "(No reply.)");
    return `- ${origin(row)}, ${when}:\n${indent(cut(said))}`;
  });
  if (unheard.length > LANE_NEWS_LIMIT)
    lines.unshift("- (More finished before these. They are in this chat's history.)");
  return {
    text: `[While you weren't in this conversation, work you did on your own in this chat finished. The user saw it here and may be replying to it:]\n${lines.join("\n")}`,
    readOutsideData: rows.some((row) => row.readOutsideData),
    runIds: unheard.map((row) => row.id),
  };
}

/** The conversation's turn carrying these results began, so it won't hear them again. */
export async function markPassedOn(db: Queryable, runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  await db
    .update(runs)
    .set({ passedOnAt: new Date() })
    .where(and(inArray(runs.id, runIds), isNull(runs.passedOnAt)));
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
