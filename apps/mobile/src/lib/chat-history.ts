import {
  applyLiveEvent,
  type ChatData,
  type ChatEntry,
  type LiveChat,
  type StreamRunEvent,
} from "@open-bot/api";

export interface ChatHistory extends LiveChat {
  watermarks: Record<string, number>;
}

const key = (entry: ChatEntry) =>
  entry.type === "message" ? `m:${entry.message.id}` : `r:${entry.run.id}`;

export function applyHistoryEvent(history: ChatHistory, event: StreamRunEvent) {
  const watermark = history.watermarks[event.runId];
  const result = applyLiveEvent({ ...history, cursor: watermark ?? history.cursor }, event);
  if (result.unknownRun || watermark === undefined || event.id <= watermark)
    return { chat: history, unknownRun: result.unknownRun };
  return {
    chat: {
      ...result.chat,
      cursor: history.cursor,
      watermarks: { ...history.watermarks, [event.runId]: event.id },
    },
    unknownRun: false,
  };
}

export function mergeSnapshot(
  previous: ChatHistory | null,
  page: ChatData,
  buffered: readonly StreamRunEvent[],
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
  for (const event of buffered) history = applyHistoryEvent(history, event).chat;
  return history;
}
