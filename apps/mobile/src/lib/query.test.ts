import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { keysForAppEvent, keysForPush, queryKeys } from "./query";

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

  it("refreshes the page list and an open page when a teammate publishes, but not its link", async () => {
    const client = new QueryClient();
    const list = queryKeys.pages;
    const page = queryKeys.page("page-1");
    const link = queryKeys.pageLink("version-1", "dark");
    client.setQueryData(list, []);
    client.setQueryData(page, { title: "Before" });
    client.setQueryData(link, { url: "https://pages/v/1" });
    await Promise.all(
      keysForAppEvent("pages").map((queryKey) => client.invalidateQueries({ queryKey })),
    );
    expect(client.getQueryState(list)?.isInvalidated).toBe(true);
    expect(client.getQueryState(page)?.isInvalidated).toBe(true);
    // The page on screen keeps its link; reloading it for nothing would lose your place.
    expect(client.getQueryState(link)?.isInvalidated).toBe(false);
    client.clear();
  });

  it("refreshes pages when a push is about one", () => {
    expect(keysForPush({ type: "notification", pageId: "page-1" })).toContainEqual(queryKeys.pages);
  });
});
