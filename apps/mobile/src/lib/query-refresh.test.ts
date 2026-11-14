import { ALWAYS_REFRESHED, APP_EVENT_REFRESHES } from "@open-bot/api";
import { appEventSchema, type AppEventType } from "@open-bot/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { keysForAppEvent, keysForPush, queryKeys } from "./query";

// Frozen pre-migration semantics, deliberately independent of the current keys and shared map.
const home = ["home"];
const screens = ["screens", "home", "teammates"];
const teammateEvent = "teammates" as const;
const oldEvents = {
  approvals: ["approvals", "approval", "approval-rules", "chat", "home", "teammates"],
  notification: ["notifications", "home"],
  chats: ["chats", "chat", "home", "teammates"],
  [teammateEvent]: ["teammates", "chats", "home", "approval-rules"],
  pages: ["pages"],
  takeovers: screens,
  lease: screens,
  computer: screens,
  memory: home,
  schedules: home,
  triggers: home,
  profile: home,
  lessons: home,
  tasks: home,
  telegram: home,
  skills: home,
  vault: home,
  connections: home,
  email: home,
  purchases: home,
  auth: home,
  settings: home,
} satisfies Record<AppEventType, string[]>;

// Every mobile query family, with multiple inputs where a prefix must reach every detail.
const queries = [
  [["screens"], queryKeys.screens],
  [
    ["home", null],
    [...queryKeys.home, null],
  ],
  [
    ["home", "yesterday"],
    [...queryKeys.home, "yesterday"],
  ],
  [["teammates"], queryKeys.teammates],
  [["chats"], queryKeys.chats],
  [["chat", "a"], queryKeys.chat("a")],
  [["chat", "b"], queryKeys.chat("b")],
  [["approvals"], queryKeys.approvals],
  [["approval", "a"], queryKeys.approval("a")],
  [["approval", "b"], queryKeys.approval("b")],
  [["approval-rules"], queryKeys.approvalRules],
  [["notifications"], queryKeys.notifications],
  [["search", "term"], queryKeys.search("term")],
  [["file", "/report.txt"], queryKeys.file("/report.txt")],
  [["pages"], queryKeys.pages],
  [["pages", "a"], queryKeys.page("a")],
  [["pages", "b"], queryKeys.page("b")],
  [["page-link", "a", "dark"], queryKeys.pageLink("a", "dark")],
  [["page-link", "b", "light"], queryKeys.pageLink("b", "light")],
] as const;

async function invalidated(keys: readonly (readonly unknown[])[], side: 0 | 1) {
  const client = new QueryClient();
  for (const pair of queries) client.setQueryData(pair[side], { present: true });
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
  const result = queries
    .filter((pair) => client.getQueryState(pair[side])?.isInvalidated)
    .map((pair) => JSON.stringify(pair[0]));
  client.clear();
  return result;
}

const eventTypes = appEventSchema.options.map((option) => option.shape.type.value);

describe("shared event refresh migration", () => {
  it.each(eventTypes)(
    "preserves every old query invalidation for %s and accounts for additions",
    async (type) => {
      const before = await invalidated(
        oldEvents[type].map((key) => [key]),
        0,
      );
      const after = await invalidated(keysForAppEvent(type), 1);
      expect(after).toEqual(expect.arrayContaining(before));
      const added = after.filter((key) => !before.includes(key));
      const expected =
        type === "pages"
          ? [
              ["home", null],
              ["home", "yesterday"],
            ]
          : type === "chats"
            ? [["approval-rules"]]
            : type === teammateEvent
              ? [
                  ["chat", "a"],
                  ["chat", "b"],
                ]
              : [];
      expect(added).toEqual(expected.map((key) => JSON.stringify(key)));
    },
  );

  it.each(eventTypes)("honors every shared procedure and snapshot path for %s", (type) => {
    // Includes procedures mobile doesn't query yet: adding a read needs no second event map.
    for (const path of [...ALWAYS_REFRESHED, ...APP_EVENT_REFRESHES[type]])
      expect(keysForAppEvent(type)).toContainEqual(path);
  });

  it("retains the old screens alias and unknown-event snapshot fallback", async () => {
    expect(await invalidated(keysForAppEvent("screens"), 1)).toEqual(
      await invalidated(
        screens.map((key) => [key]),
        0,
      ),
    );
    expect(await invalidated(keysForAppEvent("future-event"), 1)).toEqual(
      await invalidated([home], 0),
    );
  });

  it.each(eventTypes)("never reloads a signed page link for %s", async (type) => {
    const refreshed = await invalidated(keysForAppEvent(type), 1);
    expect(refreshed.some((key) => key.startsWith('["page-link"'))).toBe(false);
  });
});

describe("push refresh migration", () => {
  for (const type of ["notification", "dismiss", "egress-needed", "run-progress", "unknown"]) {
    for (let flags = 0; flags < 8; flags++) {
      it(`preserves exactly the addressed queries for ${type}, fields ${flags}`, async () => {
        const data = {
          type,
          ...(flags & 1 ? { approvalId: "a" } : {}),
          ...(flags & 2 ? { chatId: "a" } : {}),
          ...(flags & 4 ? { pageId: "a" } : {}),
        };
        const oldKeys: unknown[][] = [home];
        if (type === "notification") oldKeys.push(["notifications"], ["screens"]);
        if (data.approvalId) oldKeys.push(["approvals"], ["approval", data.approvalId]);
        if (data.chatId) oldKeys.push(["chats"], ["chat", data.chatId], ["teammates"]);
        if (data.pageId) oldKeys.push(["pages"]);
        expect(await invalidated(keysForPush(data), 1)).toEqual(await invalidated(oldKeys, 0));
      });
    }
  }
});
