import {
  applyLiveEvent,
  type ChatData,
  type ChatEntry,
  type LiveChat,
  type StreamRunEvent,
} from "@open-bot/api";

export interface ChatHistory extends LiveChat {
  /** A newer bounded snapshot cannot advance the replay checkpoint of a run it omits. */
  watermarks: Record<string, number>;
}

const key = (entry: ChatEntry) =>
  entry.type === "message" ? `m:${entry.message.id}` : `r:${entry.run.id}`;

export function applyHistoryEvent(
  history: ChatHistory,
  event: StreamRunEvent,
  after = history.cursor,
) {
  const watermark = history.watermarks[event.runId];
  const result = applyLiveEvent({ ...history, cursor: watermark ?? history.cursor }, event);
  const applied =
    !result.unknownRun && watermark !== undefined && watermark >= after && event.id > watermark;
  const advanceCheckpoint = history.cursor >= after;
  const cursor = advanceCheckpoint ? Math.max(history.cursor, event.id) : history.cursor;
  const watermarks = { ...history.watermarks };
  if (advanceCheckpoint) {
    for (const runId of Object.keys(watermarks))
      watermarks[runId] = Math.max(watermarks[runId]!, cursor);
  } else if (applied) {
    watermarks[event.runId] = event.id;
  }
  return {
    chat:
      applied || cursor !== history.cursor
        ? { ...(applied ? result.chat : history), cursor, watermarks }
        : history,
    unknownRun: result.unknownRun,
    applied,
  };
}

export function mergeSnapshot(
  previous: ChatHistory | null,
  page: ChatData,
  buffered: readonly StreamRunEvent[],
  bufferedAfter = Infinity,
): ChatHistory {
  const entries = new Map((previous?.entries ?? []).map((entry) => [key(entry), entry]));
  const runs = { ...previous?.runs };
  const watermarks = { ...previous?.watermarks };
  for (const entry of page.entries) {
    if (entry.type === "run") {
      if ((watermarks[entry.run.id] ?? -1) > page.cursor) continue;
      runs[entry.run.id] = entry.run;
      watermarks[entry.run.id] = page.cursor;
    }
    entries.set(key(entry), entry);
  }
  let history: ChatHistory = {
    entries: [...entries.values()].sort((a, b) => a.at.localeCompare(b.at)),
    runs,
    watermarks,
    cursor: Math.min(page.cursor, ...Object.values(watermarks)),
  };
  let after = bufferedAfter;
  for (const event of buffered) {
    history = applyHistoryEvent(history, event, after).chat;
    after = Math.max(after, event.id);
  }
  return history;
}
