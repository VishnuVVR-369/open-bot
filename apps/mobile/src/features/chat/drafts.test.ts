import { beforeEach, describe, expect, it, vi } from "vitest";

const { stored, storage } = vi.hoisted(() => ({
  /** The phone's AsyncStorage, with drafts an older build and this one saved. */
  stored: new Map<string, string>([
    [
      "openbot:drafts",
      JSON.stringify({ old: "Hi there", new: { text: "Book it", mentions: ["rex"] } }),
    ],
  ]),
  storage: { failing: false },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => stored.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (storage.failing) throw new Error("disk full");
      stored.set(key, value);
    },
  },
}));

import { afterSend, appendKept, keepReply, onKeptReply, readDraft, writeDraft } from "./drafts";

const saved = () => JSON.parse(stored.get("openbot:drafts") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  storage.failing = false;
});

describe("saved drafts", () => {
  it("still loads a draft an older build saved as text alone", async () => {
    expect(await readDraft("old")).toEqual({ text: "Hi there", mentions: [] });
    expect(await readDraft("new")).toEqual({ text: "Book it", mentions: ["rex"] });
    expect(await readDraft("none")).toEqual({ text: "", mentions: [] });
  });

  it("stores text alone unless it's addressed to someone, and forgets an empty one", async () => {
    writeDraft("a", { text: "Hi", mentions: [] });
    writeDraft("b", { text: "Hi", mentions: ["rex"] });
    await keepReply("c", "x", null);
    expect(saved()).toMatchObject({ a: "Hi", b: { text: "Hi", mentions: ["rex"] } });
    writeDraft("a", { text: "  ", mentions: ["rex"] });
    await keepReply("c", "y", null);
    expect(saved()).not.toHaveProperty("a");
  });
});

describe("keeping a reply a notification couldn't send", () => {
  it("adds it after the draft, addressed to the teammate it was for", () => {
    expect(appendKept({ text: "", mentions: [] }, "Book it", "rex")).toEqual({
      text: "Book it",
      mentions: ["rex"],
    });
    expect(appendKept({ text: "Also \n", mentions: ["rex"] }, "Book it", "rex")).toEqual({
      text: "Also\n\nBook it",
      mentions: ["rex"],
    });
    expect(appendKept({ text: "Also", mentions: ["mia"] }, "Book it", null)).toEqual({
      text: "Also\n\nBook it",
      mentions: ["mia"],
    });
  });

  it("tells a composer showing the chat, before it's stored, and says whether it was stored", async () => {
    const heard = vi.fn();
    const off = onKeptReply("k1", heard);
    expect(await keepReply("k1", "Book it", "rex")).toBe(true);
    expect(heard).toHaveBeenCalledWith(
      { text: "Book it", teammateId: "rex" },
      { text: "Book it", mentions: ["rex"] },
    );
    expect(saved().k1).toEqual({ text: "Book it", mentions: ["rex"] });
    off();
    storage.failing = true;
    expect(await keepReply("k1", "And lunch", null)).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("after a send", () => {
  it("leaves only the replies kept while it was on its way, each for its teammate", () => {
    expect(afterSend([])).toEqual({ text: "", mentions: [] });
    expect(afterSend([{ text: "Book the room", teammateId: "rex" }])).toEqual({
      text: "Book the room",
      mentions: ["rex"],
    });
    expect(
      afterSend([
        { text: "Book the room", teammateId: "rex" },
        { text: "And lunch", teammateId: null },
        { text: "Thanks", teammateId: "mia" },
      ]),
    ).toEqual({ text: "Book the room\n\nAnd lunch\n\nThanks", mentions: ["rex", "mia"] });
  });
});
