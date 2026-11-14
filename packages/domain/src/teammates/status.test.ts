import { describe, expect, it } from "vitest";
import { chatPlace, chatStatus, STATUS, teammateStatus, type ChatNaming } from "./status";
import type { RunStatus } from "../timeline/timeline";

type Waiting = "approval" | "takeover" | null;
const teammate = (status: RunStatus | null, waitingFor: Waiting = null, chatId = "here") => ({
  activeRun: status ? { chatId, status, waitingFor } : null,
});

const chats: Record<string, ChatNaming> = {
  here: { kind: "direct", title: "Kestrel 2.0 launch plan" },
  flights: { kind: "direct", title: "Book the Lisbon flights" },
  routine: { kind: "scheduled", title: "Scheduled" },
};
const chatById = (id: string) => chats[id];

describe("teammateStatus", () => {
  it("says what they are doing while the computer is online", () => {
    expect(teammateStatus(teammate("running"))).toEqual({
      label: STATUS.working,
      activity: "working",
      needsYou: false,
    });
    expect(teammateStatus(teammate("queued")).label).toBe(STATUS.upNext);
    expect(teammateStatus(teammate(null)).label).toBe(STATUS.idle);
  });

  it("pauses everyone who doesn't need you while the computer is offline", () => {
    for (const status of ["running", "queued", null] as const)
      expect(teammateStatus(teammate(status), false).label).toBe(STATUS.paused);
  });

  it("puts what needs you ahead of paused", () => {
    expect(teammateStatus(teammate("waiting", "approval"), false)).toEqual({
      label: STATUS.approval,
      activity: "waiting",
      needsYou: true,
    });
    expect(teammateStatus(teammate("waiting", "takeover"), false).label).toBe(STATUS.takeover);
  });
});

describe("chatStatus", () => {
  const status = (b: ReturnType<typeof teammate>, computerOnline = true) =>
    chatStatus({ teammate: b, chatId: "here", computerOnline, chatById });

  it("needs you only in the chat where the teammate is waiting", () => {
    expect(status(teammate("waiting", "approval", "here"))).toMatchObject({
      label: STATUS.approval,
      needsYou: true,
      elsewhere: null,
    });
    expect(status(teammate("waiting", "approval", "flights"))).toEqual({
      label: STATUS.idle,
      activity: "idle",
      needsYou: false,
      elsewhere: {
        chatId: "flights",
        waitingFor: "approval",
        label: "1 approval in Book the Lisbon flights",
        short: "1 approval waiting",
      },
    });
  });

  it("links a takeover elsewhere, named for the kind of chat", () => {
    expect(status(teammate("waiting", "takeover", "routine")).elsewhere?.label).toBe(
      "1 takeover in a scheduled task",
    );
    expect(status(teammate("waiting", "approval", "gone")).elsewhere?.label).toBe(
      "1 approval in another chat",
    );
  });

  it("works here, or pauses here while the computer is offline", () => {
    expect(status(teammate("running", null, "here")).label).toBe(STATUS.working);
    expect(status(teammate("queued", null, "here")).label).toBe(STATUS.upNext);
    expect(status(teammate("running", null, "here"), false).label).toBe(STATUS.paused);
  });

  it("is idle when nothing happens here, online or not, with no link for work elsewhere", () => {
    for (const online of [true, false]) {
      expect(status(teammate(null), online)).toMatchObject({ label: STATUS.idle, elsewhere: null });
      expect(status(teammate("running", null, "flights"), online)).toMatchObject({
        label: STATUS.idle,
        elsewhere: null,
      });
    }
  });
});

describe("chatPlace", () => {
  it("names a chat for a sentence", () => {
    expect(chatPlace(chats.flights)).toBe("Book the Lisbon flights");
    expect(chatPlace({ kind: "inbox", title: "Email" })).toBe("their email");
    expect(chatPlace({ kind: "direct", title: "  " })).toBe("another chat");
    expect(chatPlace(null)).toBe("another chat");
  });
});
