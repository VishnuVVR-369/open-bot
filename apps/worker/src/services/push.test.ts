import { describe, expect, it } from "vitest";
import { pushPayload } from "./push";

const base = {
  id: "n1",
  kind: "run_finished" as const,
  title: "Iris replied",
  body: "Here's the **summary** with [a link](https://x.y).",
  botId: "b1",
  chatId: "c1",
  runId: "r1",
};

describe("pushPayload", () => {
  it("opens the reply and shows plain text", () => {
    expect(pushPayload(base)).toEqual({
      title: "Iris replied",
      body: "Here's the summary with a link.",
      url: "/chats/c1#run-r1",
      tag: "r1",
    });
  });

  it("opens approvals for an approval, and replaces it when decided", () => {
    const payload = pushPayload({ ...base, kind: "approval", approvalId: "a1" });
    expect(payload.url).toBe("/approvals");
    expect(payload.tag).toBe("a1");
  });

  it("keeps the body short", () => {
    expect(pushPayload({ ...base, body: "word ".repeat(100) }).body).toHaveLength(180);
  });
});
