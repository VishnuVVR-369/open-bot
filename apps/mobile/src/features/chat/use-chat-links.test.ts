// useChat with a link to a reply: it loads the history the reply is in, then scrolls to it once.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  entry,
  hook,
  page,
  refresh,
  render,
  resetChat,
  state,
  unmountChat,
} from "./use-chat.testing";

beforeEach(resetChat);
afterEach(unmountChat);

describe("links to replies", () => {
  it("loads as many older pages as necessary, then scrolls to the requested reply once", async () => {
    state.get.mockResolvedValueOnce(page(16, 30)).mockResolvedValueOnce(page(1, 15, false));
    await render({ runId: "r5" });
    expect(state.get.mock.calls.map(([input]) => input.before)).toEqual([
      entry(31).at,
      entry(16).at,
    ]);
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(55);
    await refresh(page(32, 61));
    expect(state.scroll).toHaveBeenCalledOnce();
  });

  it("handles the newest reply at index zero without requesting history", async () => {
    await render({ runId: "r60" });
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(0);
    expect(state.get).not.toHaveBeenCalled();
  });

  it("stops at the beginning if the linked reply no longer exists", async () => {
    state.get.mockResolvedValue(page(1, 30, false));
    await render({ runId: "gone" });
    expect(state.get).toHaveBeenCalledOnce();
    expect(state.scroll).not.toHaveBeenCalled();
  });

  it("waits for an explicit retry after a page fails, then continues to the reply", async () => {
    state.get.mockRejectedValueOnce(new Error("offline"));
    await render({ runId: "r5" });
    expect(state.get).toHaveBeenCalledOnce();
    expect(hook.olderError).toBeInstanceOf(Error);
    state.get.mockResolvedValueOnce(page(16, 30)).mockResolvedValueOnce(page(1, 15, false));
    await act(async () => {
      await hook.loadOlder();
    });
    expect(state.get).toHaveBeenCalledTimes(3);
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(55);
    expect(hook.olderError).toBeNull();
  });

  it("does not fetch linked history while the chat is hidden", async () => {
    state.focused = false;
    state.get.mockResolvedValue(page(1, 30, false));
    await render({ runId: "r5" });
    expect(state.get).not.toHaveBeenCalled();
    state.focused = true;
    await render({ runId: "r5" });
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(55);
  });
});
