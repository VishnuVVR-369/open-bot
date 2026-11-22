import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../timeline/timeline";
import { progressActivity, runProgressNotice, runProgressTag } from "./run-progress";

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
      body: "Searching the web",
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

  it("says only the kind of step, never what it holds, since that could be a secret", () => {
    const secret = "dummy123";
    const tool = (name: string, label: string) =>
      ({
        id: name,
        kind: "tool",
        name,
        label,
        args: { secret },
        status: "running",
        startedAt: at,
      }) as TimelineItem;
    const cases: [TimelineItem, string][] = [
      [command(`API_TOKEN=${secret} sleep 25`), "Running a command"],
      [command(`curl -H 'Authorization: Bearer ${secret}' https://x`), "Running a command"],
      [{ ...search, query: secret } as TimelineItem, "Searching the web"],
      [
        {
          id: "f1",
          kind: "file_change",
          status: "running",
          startedAt: at,
          changes: [{ path: `/home/bot/${secret}.env`, change: "update", diff: secret }],
        } as TimelineItem,
        "Editing a file",
      ],
      [
        tool("browser_read_page", `Read https://example.com/?token=${secret}`),
        "Using the computer",
      ],
      [tool("send_email", `Email to ${secret}@example.com`), "Working on email"],
      [tool("gmail.search", `Used search ${secret}`), "Working on email"],
      [tool("search_history", `Searched past chats for “${secret}”`), "Searching past chats"],
      [tool("some_mcp.tool", `Used ${secret}`), "Using a tool"],
    ];
    for (const [item, body] of cases) {
      const notice = runProgressNotice({ ...base, items: [item] });
      expect(notice.body).toBe(body);
      expect(JSON.stringify(notice)).not.toContain(secret);
    }
  });

  it("looks past steps that say nothing to the latest one that does", () => {
    const fallback = {
      id: "m1",
      kind: "tool",
      name: "model_fallback",
      label: "Switched to the API key",
      args: {},
      status: "completed",
      startedAt: at,
    } as TimelineItem;
    expect(progressActivity([search as TimelineItem, fallback])).toBe("Searching the web");
    expect(progressActivity([search as TimelineItem, plan([["Book", "inProgress"]])])).toBe(
      "Searching the web",
    );
    expect(progressActivity([])).toBeNull();
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
