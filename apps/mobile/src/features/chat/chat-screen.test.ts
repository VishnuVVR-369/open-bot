import type { ChatEntry, RunView } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import {
  composerPlaceholder,
  headerText,
  latestActiveRun,
  supersededRuns,
  timelineRows,
} from "./chat-screen";

const run = (id: string, teammateId: string, fields: Partial<RunView> = {}) =>
  ({
    id,
    teammateId: teammateId,
    createdAt: `2026-11-13T09:0${id.length}:00Z`,
    timeline: { status: "completed", items: [] },
    ...fields,
  }) as unknown as RunView;
const message = (id: string, steeredRunId: string | null = null): ChatEntry =>
  ({ type: "message", at: "2026-11-13T09:00:00Z", message: { id, steeredRunId } }) as ChatEntry;
const runEntry = (view: RunView): ChatEntry =>
  ({ type: "run", at: view.createdAt, run: view }) as ChatEntry;
const id = (entry: ChatEntry) => (entry.type === "message" ? entry.message.id : entry.run.id);

describe("timelineRows", () => {
  it("lists newest first and leaves out messages that joined a running turn", () => {
    const steering = run("r1", "ana", {
      timeline: { status: "running", items: [{ kind: "user_message", messageId: "m2" }] },
    } as Partial<RunView>);
    const entries = [message("m1"), runEntry(steering), message("m2"), message("m3", "r1")];
    expect(timelineRows(entries, { r1: steering }).map(id)).toEqual(["r1", "m1"]);
  });
});

describe("supersededRuns", () => {
  it("marks every run but each teammate's latest", () => {
    const entries = [run("a1", "ana"), run("b1", "ben"), run("a2", "ana")].map(runEntry);
    expect([...supersededRuns(entries)]).toEqual(["a1"]);
  });
});

describe("latestActiveRun", () => {
  it("is the newest run still going", () => {
    const runs = {
      done: run("done", "ana"),
      older: run("o", "ana", { timeline: { status: "running", items: [] } } as Partial<RunView>),
      newer: run("newer", "ben", {
        timeline: { status: "waiting", items: [] },
      } as Partial<RunView>),
    };
    expect(latestActiveRun(runs)?.id).toBe("newer");
    expect(latestActiveRun({ done: runs.done })).toBeUndefined();
  });
});

describe("composerPlaceholder", () => {
  it("adds to a running turn, notes a held one, and otherwise messages the chat", () => {
    const base = { held: false, isGroup: false, name: "Ana" };
    expect(composerPlaceholder({ ...base, activeName: "Ben" })).toBe("Add to what Ben is doing…");
    expect(composerPlaceholder({ ...base, activeName: "Ben", held: true })).toBe(
      "Add a note for Ben…",
    );
    expect(composerPlaceholder({ ...base, activeName: undefined })).toBe(
      "Add to what your teammate is doing…",
    );
    expect(composerPlaceholder({ ...base, activeName: null })).toBe("Message Ana…");
    expect(composerPlaceholder({ ...base, activeName: null, isGroup: true })).toBe(
      "Message the group, @ to mention",
    );
  });
});

describe("headerText", () => {
  const idle = { activity: "idle", label: "Idle" } as const;
  it("says what is happening, or when an idle teammate was last active", () => {
    expect(
      headerText({
        status: { activity: "working", label: "Working" },
        isGroup: false,
        lastActiveAt: null,
        role: "Writer",
      }),
    ).toBe("Working");
    expect(headerText({ status: idle, isGroup: true, lastActiveAt: null, role: undefined })).toBe(
      null,
    );
    expect(headerText({ status: idle, isGroup: false, lastActiveAt: null, role: "Writer" })).toBe(
      "Writer",
    );
    expect(
      headerText({
        status: idle,
        isGroup: false,
        lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        role: "Writer",
      }),
    ).toMatch(/^Active /);
  });
});
