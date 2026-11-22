import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../timeline/timeline";
import { runProgressNotice, runProgressTag } from "./run-progress";

const at = "2026-11-22T10:00:00.000Z";
const command = (script: string) =>
  ({
    id: "c1",
    kind: "command",
    status: "running",
    startedAt: at,
    command: `/bin/bash -lc '${script}'`,
    cwd: "/home/bot",
    output: "",
    exitCode: null,
    durationMs: null,
  }) as TimelineItem;
const plan = (steps: [string, "pending" | "inProgress" | "completed"][]) =>
  ({
    id: "p1",
    kind: "plan",
    status: "running",
    startedAt: at,
    steps: steps.map(([step, status]) => ({ step, status })),
  }) as TimelineItem;
const search = { id: "w1", kind: "web_search", status: "running", startedAt: at, query: "flights" };

describe("runProgressNotice", () => {
  const base = { teammateName: "Rex", chatTitle: null, state: "working", items: [] } as const;

  it("names the plan step in progress and counts the plan's steps", () => {
    const items = [
      plan([
        ["Find flights", "completed"],
        ["Book the flight", "inProgress"],
        ["Email the receipt", "pending"],
      ]),
      search as TimelineItem,
    ];
    expect(runProgressNotice({ ...base, chatTitle: "Lisbon trip", items })).toEqual({
      title: "Rex: Book the flight",
      body: "Searching for “flights”",
      steps: { done: 1, total: 3 },
    });
  });

  it("falls back to the chat's title, then to the teammate alone", () => {
    expect(runProgressNotice({ ...base, chatTitle: "Lisbon trip" }).title).toBe("Rex: Lisbon trip");
    expect(runProgressNotice(base)).toEqual({ title: "Rex is working", body: "Working" });
    expect(runProgressNotice({ ...base, state: "starting" }).body).toBe("Getting ready");
  });

  it("says what a waiting run waits for, without repeating the request itself", () => {
    expect(runProgressNotice({ ...base, state: "waiting", waitingFor: "approval" })).toEqual({
      title: "Rex is waiting for you",
      body: "Waiting for your approval",
    });
    expect(runProgressNotice({ ...base, state: "waiting", waitingFor: "takeover" }).body).toBe(
      "Waiting for you on the screen",
    );
  });

  it("names only a command's program, since its arguments could be secrets", () => {
    const items = [command("curl -H 'Authorization: Bearer sk-123' https://x\nls")];
    expect(runProgressNotice({ ...base, items }).body).toBe("Running curl");
    expect(runProgressNotice({ ...base, items: [command("/usr/bin/python3 a.py")] }).body).toBe(
      "Running python3",
    );
  });

  it("keeps long text to one short line", () => {
    const notice = runProgressNotice({ ...base, chatTitle: `Plan\n${"a".repeat(200)}` });
    expect(notice.title).toHaveLength(80);
    expect(notice.title).toMatch(/^Rex: Plan a+…$/);
  });

  it("tags a run's progress apart from its result", () => {
    expect(runProgressTag("r1")).toBe("run-progress:r1");
  });
});
