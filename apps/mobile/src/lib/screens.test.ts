import { describe, expect, it, vi } from "vitest";
import type { ScreenView } from "@open-bot/api";
import { recoverCodeOperation, screenState, screenStatus, sortScreens } from "./screens";

describe("code recovery", () => {
  it("reads an existing operation without repeating input or cancelling it", async () => {
    const cancel = vi.fn();
    const result = { status: "typing" };
    expect(await recoverCodeOperation("id", async () => result, cancel)).toBe(result);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("inserts a cancellation tombstone when the request has not appeared", async () => {
    const cancel = vi.fn(async () => ({ status: "cancelled" }));
    expect(await recoverCodeOperation("id", async () => null, cancel)).toEqual({
      status: "cancelled",
    });
    expect(cancel).toHaveBeenCalledWith("id");
  });
  it("propagates unreachable status as unknown without cancelling or typing", async () => {
    const cancel = vi.fn();
    await expect(
      recoverCodeOperation(
        "id",
        async () => {
          throw new Error("offline");
        },
        cancel,
      ),
    ).rejects.toThrow("offline");
    expect(cancel).not.toHaveBeenCalled();
  });
});

const bot = {
  id: "b1",
  name: "Rex",
  slug: "rex",
  role: "Builder",
  color: "#3E7BFA",
  emoji: "🛠️",
  autonomy: "ask",
  isPrimary: false,
  directChatId: null,
  activeRun: null,
} as unknown as ScreenView["bot"];

function view(id: string, patch: Partial<ScreenView> = {}): ScreenView {
  return { id, bot, online: true, running: false, lease: null, requests: [], ...patch };
}

const ownerLease = {
  kind: "user",
  since: "2026-11-04T10:00:00Z",
  lastInputAt: "2026-11-04T10:00:00Z",
} as const;

describe("screen state", () => {
  it("says what the screen is doing, holder first", () => {
    expect(screenStatus(view("a"))).toBe("Asleep");
    expect(screenStatus(view("a", { running: true }))).toBe("Awake");
    expect(
      screenStatus(
        view("a", {
          running: true,
          lease: {
            kind: "run",
            runId: "r",
            botId: "b1",
            botName: "Rex",
            since: "2026-11-04T10:00:00Z",
            lastActionAt: "2026-11-04T10:00:00Z",
          },
        }),
      ),
    ).toBe("Rex is using it");
    expect(screenStatus(view("a", { online: false }))).toBe("Computer offline");
    expect(screenStatus(view("a", { lease: ownerLease, online: false }))).toBe("You're in control");
    expect(screenStatus(view("a", { lease: { ...ownerLease, pausedForSafety: true } }))).toBe(
      "Paused for safety",
    );
    expect(
      screenState(view("a", { requests: [{ id: "t", reason: "Sign in", createdAt: "" }] })),
    ).toEqual({ kind: "needs-you", reason: "Sign in", requestId: "t" });
  });
  it("puts requests first, then your screen, and keeps the rest in order", () => {
    const screens = [
      view("asleep"),
      view("mine", { running: true, lease: ownerLease }),
      view("awake", { running: true }),
      view("needs", { running: true, requests: [{ id: "t", reason: null, createdAt: "" }] }),
    ];
    expect(sortScreens(screens).map((screen) => screen.id)).toEqual([
      "needs",
      "mine",
      "asleep",
      "awake",
    ]);
  });
  it("keeps a teammate waiting for you first while the computer is offline", () => {
    const screens = [
      view("idle", { online: false }),
      view("waiting", { online: false, requests: [{ id: "t", reason: null, createdAt: "" }] }),
    ];
    expect(sortScreens(screens).map((screen) => screen.id)).toEqual(["waiting", "idle"]);
  });
});
