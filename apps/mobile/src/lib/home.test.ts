import type { ActivityItem, BotSummary, BriefingItem, ChatSummary, Home } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import { activityPlace, briefingGroups, elsewhere, rankTeammates, statusLine } from "./home";

type Run = NonNullable<BotSummary["activeRun"]>;
const teammate = (id: string, run?: Partial<Run>) =>
  ({
    id,
    name: id,
    directChatId: null,
    activeRun: run
      ? { id: `${id}-run`, chatId: `${id}-chat`, status: "running", waitingFor: null, ...run }
      : null,
  }) as BotSummary;
const home = (pendingApprovals = 0, takeovers = 0) =>
  ({
    pendingApprovals,
    takeoverRequests: Array.from({ length: takeovers }, (_, n) => ({ id: `t${n}` })),
  }) as Home;
const item = (runId: string, fields: Partial<BriefingItem> = {}) =>
  ({
    runId,
    chatId: "chat",
    chatKind: "direct",
    chatTitle: "Chat",
    botId: "ana",
    trigger: "chat",
    status: "completed",
    preview: null,
    createdAt: "2026-11-13T09:00:00Z",
    completedAt: "2026-11-13T09:00:00Z",
    automationTitle: null,
    ...fields,
  }) as BriefingItem;
const chat = (teammateId: string, lastActivityAt: string) =>
  ({ id: `${teammateId}-chat`, kind: "direct", botId: teammateId, lastActivityAt }) as ChatSummary;

describe("statusLine", () => {
  it("counts what needs you, approvals and takeovers together", () => {
    expect(statusLine(home(1), [])).toBe("1 thing needs you.");
    expect(statusLine(home(1, 2), [])).toBe("3 things need you.");
    // The loaded list wins over Home's count.
    expect(statusLine(home(4), [], false, 0)).toBe(
      "All quiet. Your teammates are ready when you are.",
    );
  });

  it("never says anyone is working while the computer is offline", () => {
    const working = [teammate("ana", {})];
    expect(statusLine(home(), working, true)).toBe(
      "Nothing needs you. Work picks up when the computer is back.",
    );
    expect(statusLine(home(), working)).toBe("ana is working on something.");
    expect(statusLine(home(), [...working, teammate("ben", {})])).toBe(
      "2 teammates are working right now.",
    );
  });

  it("doesn't count a teammate who is waiting or up next as working", () => {
    const team = [teammate("ana", { status: "waiting" }), teammate("ben", { status: "queued" })];
    expect(statusLine(home(), team)).toBe("All quiet. Your teammates are ready when you are.");
  });
});

describe("briefingGroups", () => {
  it("groups by teammate, puts failures first and counts both", () => {
    const { groups, done, failed } = briefingGroups([
      item("1"),
      item("2", { botId: "ben" }),
      item("3", { status: "failed" }),
    ]);
    expect(done).toBe(2);
    expect(failed).toBe(1);
    expect(groups.map(([id, items]) => [id, items.map((entry) => entry.runId)])).toEqual([
      ["ana", ["3", "1"]],
      ["ben", ["2"]],
    ]);
  });
});

describe("rankTeammates", () => {
  it("puts who needs you first, then who's working, then the latest conversation", () => {
    const chats = [chat("cy", "2026-11-13T08:00:00Z"), chat("di", "2026-11-13T09:00:00Z")];
    const ranked = rankTeammates(
      [teammate("cy"), teammate("ben", {}), teammate("di"), teammate("ana", { status: "waiting" })],
      chats,
    );
    expect(ranked.map((entry) => entry.id)).toEqual(["ana", "ben", "di", "cy"]);
  });
});

describe("elsewhere", () => {
  it("leaves out direct chats and keeps the four newest", () => {
    const activity: ActivityItem[] = [
      item("direct"),
      ...["1", "2", "3", "4", "5"].map((id) => item(id, { chatKind: "group" })),
    ];
    expect(elsewhere(activity).map((entry) => entry.runId)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("activityPlace", () => {
  it("names the group, or the automation that started the turn", () => {
    expect(activityPlace(item("1", { chatKind: "group", chatTitle: "Launch" }))).toBe("Launch");
    expect(activityPlace(item("1", { trigger: "watch" }))).toBe("Page changed");
    expect(activityPlace(item("1", { trigger: "gmail" }))).toBe("New mail");
    expect(activityPlace(item("1"))).toBeNull();
  });
});
