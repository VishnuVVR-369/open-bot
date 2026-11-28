import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ duplicate: vi.fn(), list: vi.fn() }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  api: { teammates: { duplicate: state.duplicate, list: state.list } },
}));
// The real ones, by path: this suite runs without the app's "@/" alias.
vi.mock("@/lib/errors", () => import("../../lib/errors"));
vi.mock("@/lib/query", () => import("../../lib/query"));
vi.mock("@/lib/haptics", () => ({
  haptics: { tap: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const { duplicateTeammate } = await import("./actions");

describe("duplicating a teammate", () => {
  const ask = { teammateId: "iris", name: "Iris 2", copyMemory: true, copyId: "copy-1" };
  beforeEach(() => {
    state.duplicate.mockReset();
    state.list.mockReset();
  });

  it("asks under the screen's copy id, and again with the same one after a lost answer", async () => {
    state.duplicate
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce({ teammateId: "copy-1", chatId: "chat", memoryCopied: false });
    expect(await duplicateTeammate(ask)).toEqual({
      ok: false,
      message: expect.any(String),
    });
    // The server answers the second ask with the copy the first made, and says its memory didn't
    // come along: the phone says what it was told, not a guess.
    expect(await duplicateTeammate(ask)).toEqual({
      ok: true,
      teammateId: "copy-1",
      memoryCopied: false,
    });
    expect(state.duplicate.mock.calls).toEqual([[ask], [ask]]);
    // Nothing is found again by name: another "Iris 2" on the team is never taken for the copy.
    expect(state.list).not.toHaveBeenCalled();
  });

  it("says why an id was refused", async () => {
    state.duplicate.mockRejectedValueOnce(
      new ORPCError("CONFLICT", { status: 409, message: "That id is already another teammate's." }),
    );
    expect(await duplicateTeammate(ask)).toEqual({
      ok: false,
      message: "That id is already another teammate's.",
    });
  });
});
