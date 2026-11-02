import { applyRunEvent, type RunEventPayload } from "@open-bot/shared";
import type { ChatData, ChatEntry, RunView } from "./views";

/**
 * Keeping a chat live. `GET /api/stream?chat=<id>&after=<cursor>` sends server-sent events:
 * - `ready` (`{ cursor }`) when connected; anything app-wide may have changed while you weren't.
 * - `app` (`{ type, id? }`) when something app-wide changed. These can't be replayed.
 * - `run` (`StreamRunEvent`) for each run event in the chat after the cursor, in order.
 * A comment line is sent every 20 seconds to keep the connection open.
 */

export interface StreamRunEvent {
  id: number;
  runId: string;
  payload: RunEventPayload;
}

export interface AppStreamEvent {
  type: string;
  id?: string;
}

export interface ServerSentEvent {
  event: string;
  data: string;
}

/** Splits a server-sent event stream into events, however the bytes arrive. */
export class SseParser {
  private buffer = "";

  /** Feed the next chunk of text; returns the events it completed. */
  push(chunk: string): ServerSentEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const events: ServerSentEvent[] = [];
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end === -1) break;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) events.push({ event, data: data.join("\n") });
    }
    return events;
  }
}

/** A chat as shown: its entries, and its runs with live timelines. */
export interface LiveChat {
  entries: ChatEntry[];
  runs: Record<string, RunView>;
  /** The last run event applied. */
  cursor: number;
}

/**
 * A chat from a snapshot, with the live events that arrived after it was taken. `unknownRun`
 * means an event belongs to a run the snapshot doesn't have yet, so fetch it again.
 */
export function liveChatFromSnapshot(
  data: ChatData,
  buffered: readonly StreamRunEvent[],
): { chat: LiveChat; unknownRun: boolean } {
  const runs: Record<string, RunView> = {};
  for (const entry of data.entries) if (entry.type === "run") runs[entry.run.id] = entry.run;
  let unknownRun = false;
  let cursor = data.cursor;
  for (const event of buffered) {
    if (event.id <= data.cursor) continue;
    const run = runs[event.runId];
    if (!run) {
      unknownRun = true;
      continue;
    }
    runs[event.runId] = { ...run, timeline: applyRunEvent(run.timeline, event.payload) };
    cursor = Math.max(cursor, event.id);
  }
  return { chat: { entries: data.entries, runs, cursor }, unknownRun };
}

/**
 * Apply one live event. Returns the same object when nothing changed, and `unknownRun` when the
 * event is for a run the chat doesn't have yet.
 */
export function applyLiveEvent(
  chat: LiveChat,
  event: StreamRunEvent,
): { chat: LiveChat; unknownRun: boolean } {
  if (event.id <= chat.cursor) return { chat, unknownRun: false };
  const run = chat.runs[event.runId];
  if (!run) return { chat, unknownRun: true };
  return {
    chat: {
      ...chat,
      cursor: event.id,
      runs: {
        ...chat.runs,
        [event.runId]: { ...run, timeline: applyRunEvent(run.timeline, event.payload) },
      },
    },
    unknownRun: false,
  };
}

/** Whether an event ends its run, so the run's final state (times, final text) is worth fetching. */
export function endsRun(event: StreamRunEvent): boolean {
  return (
    event.payload.type === "status" &&
    ["completed", "failed", "interrupted"].includes(event.payload.status)
  );
}
