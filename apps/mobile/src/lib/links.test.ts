import { describe, expect, it } from "vitest";
import { notificationHref } from "./links";

describe("where a notification goes", () => {
  it("opens the page a teammate published", () => {
    expect(
      notificationHref({ kind: "run_finished", chatId: "c1", runId: "r1", pageId: "p1" }),
    ).toBe("/pages/p1");
  });

  it("otherwise opens the reply in its chat", () => {
    expect(
      notificationHref({ kind: "run_finished", chatId: "c1", runId: "r1", pageId: null }),
    ).toBe("/chats/c1?run=r1");
  });
});
