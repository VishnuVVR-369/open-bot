import { APP_EVENT_REFRESHES, contract } from "@open-bot/api";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshAfterOutage, refreshForAppEvent, refreshSnapshots } from "./refresh";
import { orpc } from "./rpc";

const PAGE = "8c4f5f0e-3b7a-4a8e-9d55-3f2f1d0e9a01";
const SCHEDULE = "4b1f0a2c-1d3e-4f5a-8b6c-7d8e9f0a1b2c";

/** A client holding one cached result per key, none of them stale yet. */
function cacheWith(keys: Record<string, readonly unknown[]>) {
  const client = new QueryClient();
  for (const key of Object.values(keys)) client.setQueryData(key, "cached");
  const stale = () =>
    Object.entries(keys)
      .filter(([, key]) => client.getQueryState(key)?.isInvalidated)
      .map(([name]) => name)
      .sort();
  return { client, stale };
}

const keys = {
  state: orpc.app.state.queryKey(),
  home: orpc.home.get.queryKey({ input: { awaySince: null } }),
  scheduleList: orpc.schedules.list.queryKey(),
  scheduleRuns: orpc.schedules.runs.queryKey({ input: { scheduleId: SCHEDULE } }),
  tasks: orpc.tasks.list.queryKey(),
  pageList: orpc.pages.list.queryKey(),
  page: orpc.pages.get.queryKey({ input: { pageId: PAGE } }),
  pageLink: orpc.pages.open.queryKey({ input: { versionId: PAGE, theme: "dark", ask: false } }),
  chat: orpc.chats.get.queryKey({ input: { chatId: PAGE } }),
};

describe("refreshing the cache for app events", () => {
  it("refreshes every query of the procedures an event names, and nothing else", async () => {
    const { client, stale } = cacheWith(keys);
    await refreshForAppEvent(client, { type: "schedules" });
    expect(stale()).toEqual(["scheduleList", "scheduleRuns"]);
  });

  it("keeps an open page's short-lived link when pages change", async () => {
    const { client, stale } = cacheWith(keys);
    await refreshForAppEvent(client, { type: "pages" });
    expect(stale()).toEqual(["page", "pageList"]);
  });

  it("refreshes the shell's state and Home, whatever their input", async () => {
    const { client, stale } = cacheWith(keys);
    await refreshSnapshots(client);
    expect(stale()).toEqual(["home", "state"]);
  });

  it("after an outage, refreshes what events would have, but not an open chat or page link", async () => {
    const { client, stale } = cacheWith(keys);
    await refreshAfterOutage(client);
    expect(stale()).toEqual([
      "home",
      "page",
      "pageList",
      "scheduleList",
      "scheduleRuns",
      "state",
      "tasks",
    ]);
  });

  it("names only procedures the contract has", () => {
    for (const paths of Object.values(APP_EVENT_REFRESHES))
      for (const [namespace, procedure] of paths) {
        const group = contract[namespace] as Record<string, unknown>;
        expect(group, namespace).toBeDefined();
        if (procedure) expect(group[procedure], `${namespace}.${procedure}`).toBeDefined();
      }
  });
});
