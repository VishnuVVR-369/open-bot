import { describe, expect, it } from "vitest";
import { headerStatus } from "./chat-status";

const chats: Record<string, { kind: "direct"; title: string }> = {
  flights: { kind: "direct", title: "Book the Lisbon flights" },
};
const chatById = (id: string) => chats[id];
const run = (chatId: string, status: "running" | "waiting" | "queued", waitingFor = null) => ({
  activeRun: { chatId, status, waitingFor } as const,
});

describe("headerStatus", () => {
  it("says a direct chat is idle, not paused, when nothing runs in it", () => {
    const status = headerStatus({
      members: [run("flights", "waiting")],
      group: false,
      chatId: "launch",
      computerOnline: false,
      chatById,
    });
    expect(status.activity).toBe("idle");
    expect(status.elsewhere?.label).toBe("1 approval in Book the Lisbon flights");
  });

  it("says a direct chat needs you where the approval is", () => {
    const status = headerStatus({
      members: [{ activeRun: { chatId: "flights", status: "waiting", waitingFor: "approval" } }],
      group: false,
      chatId: "flights",
      computerOnline: false,
      chatById,
    });
    expect(status.label).toBe("Needs your approval");
    expect(status.elsewhere).toBeNull();
  });

  it("gives a group its most pressing member status here, and no link elsewhere", () => {
    const status = headerStatus({
      members: [run("war", "running"), run("war", "queued"), run("flights", "waiting")],
      group: true,
      chatId: "war",
      computerOnline: true,
      chatById,
    });
    expect(status.label).toBe("Working");
    expect(status.elsewhere).toBeNull();
  });

  it("pauses a group's work while the computer is offline", () => {
    const status = headerStatus({
      members: [run("war", "running"), { activeRun: null }],
      group: true,
      chatId: "war",
      computerOnline: false,
      chatById,
    });
    expect(status.label).toBe("Paused");
  });
});
