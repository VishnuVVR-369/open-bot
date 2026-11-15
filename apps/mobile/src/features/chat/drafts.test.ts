import { describe, expect, it, vi } from "vitest";

const { stored, load } = vi.hoisted(() => {
  let release!: () => void;
  return {
    /** Drafts saved on the phone earlier, as text alone. */
    stored: new Map([["openbot:drafts", JSON.stringify({ c1: "Hello", c2: "Saved" })]]),
    /** The first read of storage, held until the test lets it finish. */
    load: { done: new Promise<void>((resolve) => (release = resolve)), release: () => release() },
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    // A slow first read: it reads what's stored when it's asked, and answers later.
    getItem: (key: string) => {
      const value = stored.get(key) ?? null;
      return load.done.then(() => value);
    },
    setItem: async (key: string, value: string) => void stored.set(key, value),
  },
}));

import { readDraft, writeDraft } from "./drafts";

describe("saved drafts", () => {
  it("can't bring back a draft that was sent, or changed, before they finished loading", async () => {
    // The composer asks for its saved draft as it opens, and you send what you typed (which
    // clears it) before the phone's storage answers.
    const shown = readDraft("c1");
    writeDraft("c1", "Hello there");
    writeDraft("c1", "");
    writeDraft("c3", "New");
    load.release();
    expect(await shown).toBe("");
    expect(await readDraft("c3")).toBe("New");
    // Drafts nothing has changed load as saved, including an older build's text alone.
    expect(await readDraft("c2")).toBe("Saved");
  });
});
