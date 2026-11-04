import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { keysForAppEvent, queryKeys } from "./query";

describe("live changes from another device", () => {
  it("refreshes an open approval and its chat when an approval is decided elsewhere", async () => {
    const client = new QueryClient();
    const approval = queryKeys.approval("approval-1");
    const chat = queryKeys.chat("chat-1");
    client.setQueryData(approval, { status: "pending" });
    client.setQueryData(chat, { approvals: [{ status: "pending" }] });

    await Promise.all(
      keysForAppEvent("approvals").map((queryKey) => client.invalidateQueries({ queryKey })),
    );

    expect(client.getQueryState(approval)?.isInvalidated).toBe(true);
    expect(client.getQueryState(chat)?.isInvalidated).toBe(true);
    client.clear();
  });

  it("refreshes an open chat when it is renamed or archived elsewhere", async () => {
    const client = new QueryClient();
    const chat = queryKeys.chat("chat-1");
    client.setQueryData(chat, { title: "Before" });
    await Promise.all(
      keysForAppEvent("chats").map((queryKey) => client.invalidateQueries({ queryKey })),
    );
    expect(client.getQueryState(chat)?.isInvalidated).toBe(true);
    client.clear();
  });
});
