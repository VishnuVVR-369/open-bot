import { describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({ router: { push: vi.fn() }, usePathname: () => "/" }));
vi.mock("../../modules/share-intent", () => ({ default: null }));

const { shareInbox, shouldOpenShare } = await import("./share-inbox");

const link = { text: "https://example.com/a", subject: null };
const newer = { text: "https://example.com/b", subject: "B" };

describe("share inbox", () => {
  it("keeps the latest share, each with an id of its own", () => {
    shareInbox.put(link);
    const first = shareInbox.latest()!;
    shareInbox.put(newer);
    const second = shareInbox.latest()!;
    expect(second).toMatchObject(newer);
    expect(second.id).toBeGreaterThan(first.id);
    // The same thing shared again is a new share.
    shareInbox.put(newer);
    expect(shareInbox.latest()!.id).toBeGreaterThan(second.id);
  });

  it("tells listeners about each share, and a listener that reads the inbox can't loop", () => {
    const seen: unknown[] = [];
    const unsubscribe = shareInbox.subscribe(() => seen.push(shareInbox.latest()?.text));
    // A listener that subscribes again while being told (as React can) isn't called twice.
    const again = shareInbox.subscribe(() => {
      shareInbox.subscribe(() => {})();
    });
    shareInbox.put(link);
    expect(seen).toEqual([link.text]);
    unsubscribe();
    again();
    shareInbox.put(newer);
    expect(seen).toEqual([link.text]);
  });
});

describe("opening the share screen", () => {
  const share = { id: 3, ...link };

  it("opens once per share, when the app is ready", () => {
    expect(shouldOpenShare(share, 0, true, "/")).toBe(true);
    expect(shouldOpenShare(share, 3, true, "/")).toBe(false);
    expect(shouldOpenShare(null, 0, true, "/")).toBe(false);
  });

  it("waits for sign-in and the lock", () => {
    expect(shouldOpenShare(share, 0, false, "/")).toBe(false);
  });

  it("doesn't open a second share screen over the one showing", () => {
    expect(shouldOpenShare(share, 2, true, "/share")).toBe(false);
  });
});
