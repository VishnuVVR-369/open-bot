import { beforeEach, describe, expect, it, vi } from "vitest";

const { stored, storage, load } = vi.hoisted(() => {
  let release!: () => void;
  return {
    /** The phone's AsyncStorage, with two replies an earlier run of the app kept. */
    stored: new Map<string, string>([
      [
        "openbot:unsent-replies",
        JSON.stringify([
          {
            id: "n-sent",
            chatId: "c0",
            text: "Book it",
            teammateId: "rex",
            notificationId: "run-0",
            clientId: "client-0",
          },
          {
            id: "n-fixed",
            chatId: "c0",
            text: "Bok the room",
            teammateId: "gone",
            notificationId: "run-0",
            clientId: "client-1",
          },
          { id: "broken" },
        ]),
      ],
    ]),
    storage: { failing: false },
    /** The first read of storage, held until a test lets it finish. */
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
    setItem: async (key: string, value: string) => {
      if (storage.failing) throw new Error("disk full");
      stored.set(key, value);
    },
  },
}));
let uuid = 0;
vi.mock("expo-crypto", () => ({ randomUUID: () => `uuid-${++uuid}` }));

import {
  clearUnsentReplies,
  discardUnsentReply,
  editUnsentReply,
  keepUnsentReply,
  sendUnsentReply,
  unsentReplies,
} from "./unsent-replies";

const saved = () =>
  JSON.parse(stored.get("openbot:unsent-replies") ?? "[]") as { id: string; text: string }[];
const reply = (id: string, text = "Book it", teammateId: string | null = "rex") => ({
  id,
  chatId: "c1",
  text,
  teammateId,
  notificationId: "run-1",
});
/** A send that's on its way until the test says how it went. */
function pendingDelivery() {
  let settle!: (failure: { error: string } | null) => void;
  const deliver = vi.fn(
    () => new Promise<{ error: string } | null>((resolve) => (settle = resolve)),
  );
  return { deliver, settle: (failure: { error: string } | null = null) => settle(failure) };
}

beforeEach(() => {
  storage.failing = false;
});

describe("loading the replies kept earlier", () => {
  // First: the store reads storage once, when it's imported.
  it("waits for them, so a reply sent, edited or kept before they load can't be undone by the load", async () => {
    // Nothing shows until they've loaded, rather than something stale.
    expect(unsentReplies("c0")).toEqual([]);
    const sent = pendingDelivery();
    const sending = sendUnsentReply("n-sent", sent.deliver);
    const fixed = editUnsentReply("n-fixed", { text: "Book the room", teammateId: "mia" });
    const kept = keepUnsentReply(reply("n-new"));
    load.release();
    expect(await fixed).toBe(true);
    expect(await kept).toBe(true);
    sent.settle();
    expect(await sending).toBe(true);
    expect(sent.deliver).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-0" }));
    expect(unsentReplies("c0")).toEqual([
      expect.objectContaining({ id: "n-fixed", text: "Book the room", teammateId: "mia" }),
    ]);
    await vi.waitFor(() =>
      expect(saved().map(({ id, text }) => [id, text])).toEqual([
        ["n-fixed", "Book the room"],
        ["n-new", "Book it"],
      ]),
    );
    await clearUnsentReplies();
  });
});

describe("keeping a reply", () => {
  it("keeps each on its own, for its chat and teammate, and says whether it's stored", async () => {
    expect(await keepUnsentReply(reply("a"))).toBe(true);
    expect(await keepUnsentReply({ ...reply("b", "Lunch?", null), chatId: "c2" })).toBe(true);
    expect(unsentReplies("c1")).toEqual([
      { ...reply("a"), clientId: expect.any(String), sending: false, error: null },
    ]);
    expect(unsentReplies("c2")).toEqual([expect.objectContaining({ text: "Lunch?" })]);
    storage.failing = true;
    expect(await keepUnsentReply(reply("c"))).toBe(false);
    await clearUnsentReplies();
  });

  it("keeps the same reply once, as you edited it", async () => {
    await keepUnsentReply(reply("a"));
    await editUnsentReply("a", { text: "Book the big room" });
    await keepUnsentReply(reply("a"));
    expect(unsentReplies("c1")).toEqual([expect.objectContaining({ text: "Book the big room" })]);
    await clearUnsentReplies();
  });
});

describe("sending a reply", () => {
  it("sends it once, however many composers try, and removes it by id once it arrives", async () => {
    await keepUnsentReply(reply("a"));
    await keepUnsentReply(reply("b", "And lunch"));
    const first = pendingDelivery();
    const second = pendingDelivery();
    const sending = sendUnsentReply("a", first.deliver);
    expect(await sendUnsentReply("a", second.deliver)).toBe(false);
    await vi.waitFor(() => expect(unsentReplies("c1")[0]!.sending).toBe(true));
    // On its way, it can't change: what's sent is what's removed.
    expect(await editUnsentReply("a", { text: "Changed" })).toBe(false);
    expect(await discardUnsentReply("a")).toBe(false);
    first.settle();
    expect(await sending).toBe(true);
    expect(second.deliver).not.toHaveBeenCalled();
    expect(unsentReplies("c1").map(({ id }) => id)).toEqual(["b"]);
    await clearUnsentReplies();
  });

  it("keeps one that failed, with why, and sends it again as the same message until it's edited", async () => {
    await keepUnsentReply(reply("a"));
    const clientId = unsentReplies("c1")[0]!.clientId;
    const deliver = vi.fn(async () => ({ error: "You're offline." }));
    expect(await sendUnsentReply("a", deliver)).toBe(false);
    expect(unsentReplies("c1")[0]).toMatchObject({ sending: false, error: "You're offline." });
    await sendUnsentReply("a", deliver);
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ clientId }));
    await editUnsentReply("a", { text: "Book the big room" });
    expect(unsentReplies("c1")[0]).toMatchObject({ error: null });
    await sendUnsentReply("a", deliver);
    expect(deliver).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Book the big room",
        clientId: expect.not.stringMatching(clientId),
      }),
    );
    // A send that throws fails the same way.
    expect(await sendUnsentReply("a", () => Promise.reject(new Error("boom")))).toBe(false);
    expect(unsentReplies("c1")[0]!.error).toBe("Couldn't send. Try again.");
    await clearUnsentReplies();
  });
});

describe("editing and discarding", () => {
  it("changes the text and whom it's for, but never to nothing", async () => {
    await keepUnsentReply(reply("a"));
    expect(await editUnsentReply("a", { teammateId: "mia" })).toBe(true);
    expect(await editUnsentReply("a", { text: "  " })).toBe(false);
    expect(unsentReplies("c1")[0]).toMatchObject({ text: "Book it", teammateId: "mia" });
    expect(await discardUnsentReply("a")).toBe(true);
    expect(unsentReplies("c1")).toEqual([]);
    expect(await discardUnsentReply("a")).toBe(false);
    expect(saved()).toEqual([]);
  });
});
