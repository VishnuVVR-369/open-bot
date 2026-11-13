import { describe, expect, it } from "vitest";
import {
  reduceScreenSession,
  screenActions,
  screenSession,
  typedChange,
  type ScreenEvent,
  type ScreenSession,
} from "./screen-session";

const run = (state: ScreenSession, ...events: ScreenEvent[]) =>
  events.reduce(reduceScreenSession, state);
const fresh = screenSession({ takeoverId: null, code: false });

describe("screenSession", () => {
  it("opens the code sheet a link asks for, and follows the link when it changes", () => {
    expect(screenSession({ takeoverId: "t1", code: true }).code).toEqual({
      takeoverId: "t1",
      open: true,
    });
    const state = run(fresh, { type: "link", takeoverId: "t2", code: false });
    expect(state.code).toEqual({ takeoverId: "t2", open: false });
  });

  it("opens the code sheet from the notice, and unmounts it on close", () => {
    const open = run(fresh, { type: "open-code", takeoverId: "t1" });
    expect(open.code).toEqual({ takeoverId: "t1", open: true });
    expect(run(open, { type: "close-code" }).code).toEqual({ takeoverId: null, open: false });
  });

  it("keeps the hand-back note until the screen is handed back", () => {
    const asked = run(fresh, { type: "ask-hand-back" }, { type: "note", note: "Logged in" });
    expect(run(asked, { type: "cancel-hand-back" })).toMatchObject({
      handBack: false,
      note: "Logged in",
    });
    expect(run(asked, { type: "handed-back" })).toMatchObject({ handBack: false, note: "" });
  });

  it("tracks the request in flight", () => {
    const waking = run(fresh, { type: "start", pending: "wake" });
    expect(waking.pending).toBe("wake");
    expect(run(waking, { type: "settle" }).pending).toBeNull();
  });

  it("holds modifier keys until they come back up", () => {
    const held = run(
      fresh,
      { type: "hold", code: "ControlLeft", down: true },
      { type: "hold", code: "AltLeft", down: true },
      { type: "hold", code: "ControlLeft", down: false },
    );
    expect(held.held).toEqual(["AltLeft"]);
  });

  it("starts the remote keyboard over when control or the stream changes", () => {
    const typing = run(
      fresh,
      { type: "typed", draft: "hello" },
      { type: "toggle-trackpad" },
      { type: "hold", code: "ControlLeft", down: true },
      { type: "ask-hand-back" },
    );
    expect(run(typing, { type: "input-reset" })).toEqual({ ...fresh, handBack: true });
  });

  it("closes the code sheet and forgets the keyboard when the app locks", () => {
    const state = run(
      fresh,
      { type: "open-code", takeoverId: "t1" },
      { type: "typed", draft: "secret" },
      { type: "hold", code: "AltLeft", down: true },
      { type: "toggle-trackpad" },
      { type: "access-lost" },
    );
    expect(state).toMatchObject({
      code: { takeoverId: "t1", open: false },
      draft: "",
      held: [],
      trackpad: true,
    });
  });
});

describe("typedChange", () => {
  it("sends what was added after the shared prefix", () => {
    expect(typedChange("hel", "hello")).toEqual({ backspaces: 0, text: "lo" });
  });
  it("backspaces over what changed, then types the rest", () => {
    expect(typedChange("hello", "help")).toEqual({ backspaces: 2, text: "p" });
    expect(typedChange("abc", "")).toEqual({ backspaces: 3, text: "" });
    expect(typedChange("", "")).toEqual({ backspaces: 0, text: "" });
  });
});

describe("screenActions", () => {
  const titles = (actions: ReturnType<typeof screenActions>) =>
    actions.map((action) => `${action.title}${action.primary ? "*" : ""}`);

  it("offers only hand back while you control the screen", () => {
    expect(titles(screenActions(true, { kind: "controlling", paused: false }))).toEqual([
      "Hand back*",
    ]);
  });
  it("retries an offline computer, and wakes a sleeping screen first", () => {
    expect(titles(screenActions(false, { kind: "offline" }))).toEqual(["Try again*"]);
    expect(titles(screenActions(false, { kind: "asleep" }))).toEqual(["Take over", "Wake screen*"]);
  });
  it("otherwise offers to take over", () => {
    for (const state of [
      { kind: "awake" },
      { kind: "using", botName: "Ana" }, // vocabulary: allow (ScreenState field)
      { kind: "needs-you", reason: null, requestId: "t1" },
    ] as const)
      expect(titles(screenActions(false, state))).toEqual(["Take over*"]);
  });
});
