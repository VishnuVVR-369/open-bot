import { describe, expect, it } from "vitest";
import {
  applyLiveEvent,
  endsRun,
  liveChatFromSnapshot,
  SseParser,
  type StreamRunEvent,
} from "./live";
import type { ChatData, RunView } from "./views";

describe("SseParser", () => {
  it("parses events split anywhere across chunks", () => {
    const text =
      'event: ready\ndata: {"cursor":4}\n\n: keep-alive\n\nevent: run\ndata: {"id":5}\n\n';
    for (let size = 1; size <= text.length; size++) {
      const parser = new SseParser();
      const events = [];
      for (let i = 0; i < text.length; i += size)
        events.push(...parser.push(text.slice(i, i + size)));
      expect(events).toEqual([
        { event: "ready", data: '{"cursor":4}' },
        { event: "run", data: '{"id":5}' },
      ]);
    }
  });

  it("handles CRLF, multi-line data and events without a name", () => {
    const parser = new SseParser();
    expect(parser.push("data: a\r\ndata: b\r\n\r\nevent: app\ndata:x\n\n")).toEqual([
      { event: "message", data: "a\nb" },
      { event: "app", data: "x" },
    ]);
  });
});

function run(id: string, text = ""): RunView {
  return {
    id,
    botId: "b",
    trigger: "user",
    messageId: null,
    parentRunId: null,
    fromBotId: null,
    authMode: null,
    scheduleTitle: null,
    triggerTitle: null,
    automationPrompt: null,
    rating: null,
    usage: null,
    createdAt: "2026-11-02T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    timeline: {
      status: "running",
      items: [
        {
          id: "m",
          kind: "message",
          phase: "final",
          text,
          status: "running",
          startedAt: "2026-11-02T00:00:00.000Z",
        },
      ],
    },
  };
}

const snapshot: ChatData = {
  chat: {
    id: "c",
    kind: "direct",
    title: "Rex",
    botId: "b",
    memberIds: ["b"],
    lastActivityAt: "2026-11-02T00:00:00.000Z",
    active: true,
  },
  members: [],
  entries: [{ type: "run", at: "2026-11-02T00:00:00.000Z", run: run("r1", "Hel") }],
  cursor: 10,
  hasMore: false,
  helper: null,
};

const delta = (id: number, text: string, runId = "r1"): StreamRunEvent => ({
  id,
  runId,
  payload: { type: "delta", itemId: "m", delta: text },
});

const textOf = (runView: RunView | undefined) =>
  runView?.timeline.items[0]?.kind === "message" ? runView.timeline.items[0].text : null;

describe("live chats", () => {
  it("applies buffered events newer than the snapshot, once", () => {
    const { chat, unknownRun } = liveChatFromSnapshot(snapshot, [
      delta(9, "ignored"),
      delta(11, "lo"),
    ]);
    expect(unknownRun).toBe(false);
    expect(textOf(chat.runs.r1)).toBe("Hello");
    expect(chat.cursor).toBe(11);
    // The same event again, as after a reconnect, changes nothing.
    expect(applyLiveEvent(chat, delta(11, "lo")).chat).toBe(chat);
    expect(textOf(applyLiveEvent(chat, delta(12, "!")).chat.runs.r1)).toBe("Hello!");
  });

  it("asks for a fresh snapshot when a run it doesn't know starts", () => {
    const { chat } = liveChatFromSnapshot(snapshot, []);
    expect(applyLiveEvent(chat, delta(11, "x", "r2")).unknownRun).toBe(true);
    expect(liveChatFromSnapshot(snapshot, [delta(11, "x", "r2")]).unknownRun).toBe(true);
  });

  it("knows which events end a run", () => {
    expect(endsRun({ id: 1, runId: "r", payload: { type: "status", status: "completed" } })).toBe(
      true,
    );
    expect(endsRun({ id: 1, runId: "r", payload: { type: "status", status: "running" } })).toBe(
      false,
    );
    expect(endsRun(delta(1, "x"))).toBe(false);
  });
});
