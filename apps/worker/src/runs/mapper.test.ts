import type { v2 } from "@open-bot/agent";
import { describe, expect, it } from "vitest";
import { finalText, mapThreadItem } from "./mapper";

const now = "2026-10-14T10:00:00.000Z";

describe("mapThreadItem", () => {
  it("maps agent messages with their phase", () => {
    const item = {
      type: "agentMessage",
      id: "m1",
      text: "Done.",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    } as v2.ThreadItem;
    expect(mapThreadItem(item, "completed", now)).toMatchObject({
      kind: "message",
      phase: "final",
      text: "Done.",
      status: "completed",
    });
    const note = { ...item, phase: "commentary" } as v2.ThreadItem;
    expect(mapThreadItem(note, "started", now)).toMatchObject({
      phase: "commentary",
      status: "running",
    });
  });

  it("marks failed commands as failed and keeps their output", () => {
    const item = {
      type: "commandExecution",
      id: "c1",
      command: "ls missing",
      cwd: "/home/bot",
      status: "failed",
      aggregatedOutput: "No such file",
      exitCode: 2,
      durationMs: 10,
    } as unknown as v2.ThreadItem;
    expect(mapThreadItem(item, "completed", now)).toMatchObject({
      kind: "command",
      status: "failed",
      output: "No such file",
      exitCode: 2,
    });
  });

  it("drops empty reasoning and our own dynamic tools", () => {
    const reasoning = { type: "reasoning", id: "r1", summary: [], content: [] } as v2.ThreadItem;
    expect(mapThreadItem(reasoning, "completed", now)).toBeNull();
    const tool = {
      type: "dynamicToolCall",
      id: "t1",
      tool: "desktop_click",
    } as unknown as v2.ThreadItem;
    expect(mapThreadItem(tool, "completed", now)).toBeNull();
  });

  it("picks the final answer over progress notes", () => {
    const items = [
      {
        id: "a",
        kind: "message",
        phase: "commentary",
        text: "Working on it",
        status: "completed",
        startedAt: now,
      },
      {
        id: "b",
        kind: "message",
        phase: "final",
        text: "The answer",
        status: "completed",
        startedAt: now,
      },
      {
        id: "c",
        kind: "message",
        phase: "commentary",
        text: "One more note",
        status: "completed",
        startedAt: now,
      },
    ] as const;
    expect(finalText([...items])).toBe("The answer");
  });
});
